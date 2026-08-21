open Piss_shared.Domain

exception Store_error of string

type accepted_command = { state : command_state; duplicate : bool }

type recovered_command = {
  state : command_state;
  duplicate : bool;
  prompt : string;
}

type runtime_identity = { worker_id : string; runtime_generation : int }

type t = {
  db : Sqlite3.db;
  session_id : session_id;
  worker_id : worker_id;
  claimed_runtime : runtime_identity option ref;
  event_count : int64 ref;
}

let max_retained_events = 65_536
let max_retained_command_receipts = 1024
let max_retained_commands = max_retained_command_receipts

(* Event kinds whose retention is required by the durability contract:
   permission requests, command acceptances, harness disconnects, and
   reconciliation records must never be silently dropped when compaction runs.
   Compaction is allowed to remove ordinary tool/agent updates that are still
   replayable from the harness transcript. *)
let retained_event_kinds =
  [
    "command.accepted";
    "command.state";
    "command.reconciled";
    "command.recovered";
    "command.dispatch_timeout";
    "acp.response";
    "acp.permission.requested";
    "acp.permission.resolved";
    "acp.permission.cancelled";
    "acp.permission.expired";
    "acp.initialize";
    "acp.session.created";
    "acp.session.loaded";
    "acp.session.load_failed";
    "acp.config_option.changed";
    "acp.config_option.restored";
    "acp.config_option.restore_failed";
    "acp.client_request.rejected";
    "harness.disconnected";
    "harness.protocol_error";
    "worker.upgrade.prepared";
    "worker.upgrade.completed";
    "worker.upgrade.expired";
    "timeline.reset";
  ]

let fail_rc operation rc =
  if not (Sqlite3.Rc.is_success rc) then
    raise
      (Store_error
         (Printf.sprintf "%s failed: %s" operation (Sqlite3.Rc.to_string rc)))

let exec db sql = fail_rc sql (Sqlite3.exec db sql)

let with_statement db sql f =
  let statement = Sqlite3.prepare db sql in
  Fun.protect
    ~finally:(fun () -> fail_rc "finalize" (Sqlite3.finalize statement))
    (fun () -> f statement)

let bind_text statement position value =
  fail_rc "bind text" (Sqlite3.bind_text statement position value)

let bind_int64 statement position value =
  fail_rc "bind int64" (Sqlite3.bind_int64 statement position value)

let bind_float statement position value =
  fail_rc "bind float" (Sqlite3.bind_double statement position value)

let expect_done operation statement =
  match Sqlite3.step statement with
  | Sqlite3.Rc.DONE -> ()
  | rc -> fail_rc operation rc

let table_has_column db table column =
  Piss_persistence.Sqlite_support.has_column db ~table ~column

let initialize db =
  Piss_persistence.Sqlite_support.configure_durable db;
  exec db
    "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT \
     NULL)";
  exec db
    "CREATE TABLE IF NOT EXISTS commands (command_id TEXT PRIMARY \
     KEY,request_id TEXT NOT NULL UNIQUE,prompt TEXT NOT NULL,content TEXT NOT \
     NULL DEFAULT '[]',acceptance_sequence INTEGER NOT NULL DEFAULT 0,state \
     TEXT NOT NULL,created_at REAL NOT NULL,updated_at REAL NOT NULL)";
  if not (table_has_column db "commands" "content") then
    exec db "ALTER TABLE commands ADD COLUMN content TEXT NOT NULL DEFAULT '[]'";
  if not (table_has_column db "commands" "acceptance_sequence") then
    exec db
      "ALTER TABLE commands ADD COLUMN acceptance_sequence INTEGER NOT NULL \
       DEFAULT 0";
  exec db
    "CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY \
     AUTOINCREMENT,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at REAL \
     NOT NULL)";
  exec db "CREATE INDEX IF NOT EXISTS events_kind_idx ON events(kind, sequence)";
  let needs_acceptance_backfill =
    with_statement db
      "SELECT 1 FROM commands WHERE acceptance_sequence = 0 LIMIT 1"
      (fun statement ->
        match Sqlite3.step statement with
        | Sqlite3.Rc.ROW -> true
        | Sqlite3.Rc.DONE -> false
        | rc ->
            fail_rc "inspect command acceptance sequence migration" rc;
            false)
  in
  if needs_acceptance_backfill then (
    let acceptances = Hashtbl.create 32 in
    with_statement db
      "SELECT sequence,payload FROM events WHERE kind = 'command.accepted' \
       ORDER BY sequence" (fun statement ->
        let rec collect () =
          match Sqlite3.step statement with
          | Sqlite3.Rc.ROW ->
              let sequence = Sqlite3.column_int64 statement 0 in
              let payload =
                Sqlite3.column_text statement 1 |> Yojson.Safe.from_string
              in
              (match Yojson.Safe.Util.member "commandId" payload with
              | `String command_id ->
                  Hashtbl.replace acceptances command_id sequence
              | _ -> ());
              collect ()
          | Sqlite3.Rc.DONE -> ()
          | rc -> fail_rc "backfill command acceptance sequences" rc
        in
        collect ());
    Hashtbl.iter
      (fun command_id sequence ->
        with_statement db
          "UPDATE commands SET acceptance_sequence = ? WHERE command_id = ? \
           AND acceptance_sequence = 0" (fun statement ->
            bind_int64 statement 1 sequence;
            bind_text statement 2 command_id;
            expect_done "backfill command acceptance sequence" statement))
      acceptances)

let count_events db =
  with_statement db "SELECT COUNT(*) FROM events" (fun statement ->
      match Sqlite3.step statement with
      | Sqlite3.Rc.ROW -> Sqlite3.column_int64 statement 0
      | rc ->
          fail_rc "count events" rc;
          0L)

let open_ ~path ~session_id ~worker_id =
  let db = Sqlite3.db_open path in
  initialize db;
  {
    db;
    session_id;
    worker_id;
    claimed_runtime = ref None;
    event_count = ref (count_events db);
  }

let close store =
  if not (Sqlite3.db_close store.db) then
    raise (Store_error "close database failed: database is busy")

let transaction store f =
  exec store.db "BEGIN IMMEDIATE";
  try
    let result = f () in
    exec store.db "COMMIT";
    result
  with exn ->
    (try exec store.db "ROLLBACK" with _ -> ());
    store.event_count := count_events store.db;
    raise exn

let scalar_int64 store ~operation sql =
  with_statement store.db sql (fun statement ->
      match Sqlite3.step statement with
      | Sqlite3.Rc.ROW -> Sqlite3.column_int64 statement 0
      | rc ->
          fail_rc operation rc;
          0L)

let last_sequence store =
  scalar_int64 store ~operation:"read last sequence"
    "SELECT COALESCE(MAX(sequence), 0) FROM events"

let first_retained_sequence store =
  scalar_int64 store ~operation:"read first retained sequence"
    "SELECT COALESCE(MIN(sequence), 0) FROM events"

let last_finished_at store =
  with_statement store.db
    "SELECT state, updated_at FROM commands ORDER BY updated_at DESC, \
     created_at DESC, command_id DESC LIMIT 1" (fun statement ->
      match Sqlite3.step statement with
      | Sqlite3.Rc.ROW ->
          let state = Sqlite3.column_text statement 0 in
          if
            List.mem state [ "completed"; "cancelled"; "ambiguous"; "rejected" ]
          then Some (Sqlite3.column_double statement 1)
          else None
      | Sqlite3.Rc.DONE -> None
      | rc ->
          fail_rc "read last finished command timestamp" rc;
          None)

let get_metadata store key =
  with_statement store.db "SELECT value FROM metadata WHERE key = ?"
    (fun statement ->
      bind_text statement 1 key;
      match Sqlite3.step statement with
      | Sqlite3.Rc.ROW -> Some (Sqlite3.column_text statement 0)
      | Sqlite3.Rc.DONE -> None
      | rc ->
          fail_rc "read metadata" rc;
          None)

let set_metadata store key value =
  with_statement store.db
    "INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE \
     SET value = excluded.value" (fun statement ->
      bind_text statement 1 key;
      bind_text statement 2 value;
      expect_done "write metadata" statement)

let claim_runtime store =
  let identity =
    transaction store (fun () ->
        let session_id = session_id_to_string store.session_id in
        let legacy_runtime =
          Option.is_some (get_metadata store "worker_generation")
          || Option.is_some (get_metadata store "acp_session_id")
        in
        (match get_metadata store "piss_session_id" with
        | None -> set_metadata store "piss_session_id" session_id
        | Some durable when String.equal durable session_id -> ()
        | Some durable ->
            raise
              (Store_error
                 (Printf.sprintf
                    "worker database belongs to session %s, not requested \
                     session %s"
                    durable session_id)));
        let previous =
          match get_metadata store "runtime_generation" with
          | None -> if legacy_runtime then 1 else 0
          | Some value -> (
              match int_of_string_opt value with
              | Some generation when generation >= 0 -> generation
              | _ -> raise (Store_error "durable runtime generation is invalid")
              )
        in
        if previous = max_int then
          raise (Store_error "durable runtime generation is exhausted");
        let runtime_generation = previous + 1 in
        let worker_seed = worker_id_to_string store.worker_id in
        let worker_id =
          "worker-"
          ^ Digest.to_hex
              (Digest.string
                 (session_id ^ "\000" ^ worker_seed ^ "\000"
                 ^ string_of_int runtime_generation))
        in
        set_metadata store "runtime_generation"
          (string_of_int runtime_generation);
        set_metadata store "runtime_worker_id" worker_id;
        { worker_id; runtime_generation })
  in
  store.claimed_runtime := Some identity;
  identity

let stale_runtime_reason store (target : runtime_target) =
  let requested_session = session_id_to_string target.session_id in
  let process_session = session_id_to_string store.session_id in
  let durable_session = get_metadata store "piss_session_id" in
  let requested_worker = worker_id_to_string target.worker_id in
  let durable_worker = get_metadata store "runtime_worker_id" in
  let requested_generation =
    runtime_generation_to_int target.runtime_generation
  in
  let durable_generation =
    Option.bind (get_metadata store "runtime_generation") int_of_string_opt
  in
  match !(store.claimed_runtime) with
  | None ->
      Some "stale runtime target: worker process has not claimed a runtime"
  | Some _ when not (String.equal process_session requested_session) ->
      Some "stale runtime target: session identity changed"
  | Some claimed when not (String.equal claimed.worker_id requested_worker) ->
      Some "stale runtime target: worker incarnation changed"
  | Some claimed when claimed.runtime_generation <> requested_generation ->
      Some "stale runtime target: runtime generation changed"
  | Some _ -> (
      match (durable_session, durable_worker, durable_generation) with
      | Some session, _, _ when not (String.equal session requested_session) ->
          Some "stale runtime target: durable session identity changed"
      | _, Some worker, _ when not (String.equal worker requested_worker) ->
          Some "stale runtime target: worker incarnation changed"
      | _, _, Some generation when generation <> requested_generation ->
          Some "stale runtime target: runtime generation changed"
      | Some _, Some _, Some _ -> None
      | _ -> Some "stale runtime target: worker runtime identity is unavailable"
      )

let validate_runtime_target store target =
  transaction store (fun () ->
      match stale_runtime_reason store target with
      | None -> Ok ()
      | Some reason -> Error reason)

let row_count store table =
  scalar_int64 store ~operation:("count " ^ table)
    ("SELECT COUNT(*) FROM " ^ table)

(* Build the WHERE clause that protects the durable event kinds listed above
   from being dropped by compaction. *)
let retention_predicate kinds =
  "kind NOT IN ("
  ^ String.concat ", " (List.map (fun kind -> "'" ^ kind ^ "'") kinds)
  ^ ")"

let compact_events_if_needed store =
  if !(store.event_count) >= Int64.of_int max_retained_events then (
    let predicate = retention_predicate retained_event_kinds in
    exec store.db
      ("DELETE FROM events WHERE sequence IN (SELECT sequence FROM events \
        WHERE " ^ predicate ^ " ORDER BY sequence ASC LIMIT 1024)");
    store.event_count :=
      Int64.sub !(store.event_count) (Int64.of_int (Sqlite3.changes store.db)))

let append_event store ~kind ~(payload : Yojson.Safe.t) =
  compact_events_if_needed store;
  if !(store.event_count) >= Int64.of_int max_retained_events then
    raise
      (Store_error
         (Printf.sprintf
            "durable event retention limit reached (%d retained events); the \
             worker must drain or archive before further events can be \
             persisted"
            max_retained_events));
  let created_at = Unix.gettimeofday () in
  with_statement store.db
    "INSERT INTO events(kind, payload, created_at) VALUES (?, ?, ?)"
    (fun statement ->
      bind_text statement 1 kind;
      bind_text statement 2 (Yojson.Safe.to_string payload);
      bind_float statement 3 created_at;
      expect_done "append event" statement);
  store.event_count := Int64.succ !(store.event_count);
  let sequence = Sqlite3.last_insert_rowid store.db in
  { sequence; kind; payload; created_at }

let event_of_row statement =
  {
    sequence = Sqlite3.column_int64 statement 0;
    kind = Sqlite3.column_text statement 1;
    payload = Sqlite3.column_text statement 2 |> Yojson.Safe.from_string;
    created_at = Sqlite3.column_double statement 3;
  }

let event_page_bytes event =
  event_to_yojson event |> Yojson.Safe.to_string |> String.length

let add_to_page ~max_bytes ~bytes ~count event =
  let separator = if count = 0 then 0 else 1 in
  let next_bytes = bytes + separator + event_page_bytes event in
  match max_bytes with
  | Some limit when count > 0 && next_bytes > limit -> None
  | None | Some _ -> Some (next_bytes, count + 1)

let list_events ?max_bytes store ~after ~limit =
  with_statement store.db
    "SELECT sequence, kind, payload, created_at FROM events WHERE sequence > ? \
     ORDER BY sequence ASC LIMIT ?" (fun statement ->
      bind_int64 statement 1 after;
      fail_rc "bind limit" (Sqlite3.bind_int statement 2 limit);
      let rec collect bytes count events =
        match Sqlite3.step statement with
        | Sqlite3.Rc.ROW -> (
            let event = event_of_row statement in
            match add_to_page ~max_bytes ~bytes ~count event with
            | Some (bytes, count) -> collect bytes count (event :: events)
            | None -> List.rev events)
        | Sqlite3.Rc.DONE -> List.rev events
        | rc ->
            fail_rc "list events" rc;
            List.rev events
      in
      collect 2 0 [])

let list_events_before ?max_bytes store ~before ~limit =
  with_statement store.db
    "SELECT sequence, kind, payload, created_at FROM events WHERE sequence < ? \
     ORDER BY sequence DESC LIMIT ?" (fun statement ->
      bind_int64 statement 1 before;
      fail_rc "bind limit" (Sqlite3.bind_int statement 2 limit);
      let rec collect bytes count events =
        match Sqlite3.step statement with
        | Sqlite3.Rc.ROW -> (
            let event = event_of_row statement in
            match add_to_page ~max_bytes ~bytes ~count event with
            | Some (bytes, count) -> collect bytes count (event :: events)
            | None -> events)
        | Sqlite3.Rc.DONE -> events
        | rc ->
            fail_rc "list events before cursor" rc;
            events
      in
      collect 2 0 [])

let list_recent_events ?max_bytes store ~limit =
  with_statement store.db
    "SELECT sequence, kind, payload, created_at FROM events ORDER BY sequence \
     DESC LIMIT ?" (fun statement ->
      fail_rc "bind limit" (Sqlite3.bind_int statement 1 limit);
      let rec collect bytes count events =
        match Sqlite3.step statement with
        | Sqlite3.Rc.ROW -> (
            let event = event_of_row statement in
            match add_to_page ~max_bytes ~bytes ~count event with
            | Some (bytes, count) -> collect bytes count (event :: events)
            | None -> events)
        | Sqlite3.Rc.DONE -> events
        | rc ->
            fail_rc "list recent events" rc;
            events
      in
      collect 2 0 [])

let find_command store command_id =
  with_statement store.db "SELECT state FROM commands WHERE command_id = ?"
    (fun statement ->
      bind_text statement 1 command_id;
      match Sqlite3.step statement with
      | Sqlite3.Rc.ROW -> (
          match command_state_of_string (Sqlite3.column_text statement 0) with
          | Ok state -> Some state
          | Error message -> raise (Store_error message))
      | Sqlite3.Rc.DONE -> None
      | rc ->
          fail_rc "find command" rc;
          None)

let find_command_record store command_id =
  with_statement store.db
    "SELECT prompt, content, state FROM commands WHERE command_id = ?"
    (fun statement ->
      bind_text statement 1 command_id;
      match Sqlite3.step statement with
      | Sqlite3.Rc.ROW -> (
          match command_state_of_string (Sqlite3.column_text statement 2) with
          | Ok state ->
              Some
                ( Sqlite3.column_text statement 0,
                  Sqlite3.column_text statement 1,
                  state )
          | Error message -> raise (Store_error message))
      | Sqlite3.Rc.DONE -> None
      | rc ->
          fail_rc "find command record" rc;
          None)

let command_acceptance store command_id =
  with_statement store.db
    "SELECT payload FROM events WHERE kind = 'command.accepted' ORDER BY \
     sequence" (fun statement ->
      let rec find found =
        match Sqlite3.step statement with
        | Sqlite3.Rc.ROW ->
            let payload =
              Sqlite3.column_text statement 0 |> Yojson.Safe.from_string
            in
            let found =
              match Yojson.Safe.Util.member "commandId" payload with
              | `String id when String.equal id command_id -> Some payload
              | _ -> found
            in
            find found
        | Sqlite3.Rc.DONE -> found
        | rc ->
            fail_rc "find command acceptance" rc;
            found
      in
      find None)

let compact_terminal_command_receipts store =
  let count = row_count store "commands" in
  let limit = Int64.of_int max_retained_command_receipts in
  if Int64.compare count limit >= 0 then (
    let remove_count = Int64.(to_int (add (sub count limit) 1L)) in
    with_statement store.db
      "DELETE FROM commands WHERE command_id IN (SELECT command_id FROM \
       commands WHERE state IN \
       ('completed','cancelled','ambiguous','rejected') ORDER BY updated_at \
       ASC,created_at ASC,command_id ASC LIMIT ?)" (fun statement ->
        fail_rc "bind command receipt compaction limit"
          (Sqlite3.bind_int statement 1 remove_count);
        expect_done "compact terminal command receipts" statement);
    if Sqlite3.changes store.db < remove_count then
      raise
        (Store_error
           (Printf.sprintf
              "command receipt capacity exhausted (%d retained non-terminal \
               commands)"
              max_retained_command_receipts)))

let accept_command_unlocked ?(action = "prompt") ?(content = `List [])
    ?(images = []) ?(resources = []) store ~command_id ~request_id ~prompt =
  match find_command store command_id with
  | Some state -> { state; duplicate = true }
  | None ->
      compact_terminal_command_receipts store;
      let now = Unix.gettimeofday () in
      with_statement store.db
        "INSERT INTO commands(command_id, request_id, prompt, content, state, \
         created_at, updated_at) VALUES (?, ?, ?, ?, 'accepted', ?, ?)"
        (fun statement ->
          bind_text statement 1 command_id;
          bind_text statement 2 request_id;
          bind_text statement 3 prompt;
          bind_text statement 4 (Yojson.Safe.to_string content);
          bind_float statement 5 now;
          bind_float statement 6 now;
          expect_done "accept command" statement);
      let acceptance =
        append_event store ~kind:"command.accepted"
          ~payload:
            (`Assoc
               [
                 ("commandId", `String command_id);
                 ("requestId", `String request_id);
                 ("action", `String action);
                 ("text", `String prompt);
                 ("imageCount", `Int (List.length images));
                 ("images", `List images);
                 ("resourceCount", `Int (List.length resources));
                 ("resources", `List resources);
               ])
      in
      with_statement store.db
        "UPDATE commands SET acceptance_sequence = ? WHERE command_id = ?"
        (fun statement ->
          bind_int64 statement 1 acceptance.sequence;
          bind_text statement 2 command_id;
          expect_done "record command acceptance sequence" statement);
      { state = Accepted; duplicate = false }

let accept_command ?action ?content ?images ?resources store ~command_id
    ~request_id ~prompt =
  transaction store (fun () ->
      accept_command_unlocked ?action ?content ?images ?resources store
        ~command_id ~request_id ~prompt)

let accept_targeted_command ?action ?content ?images ?resources store ~target
    ~command_id ~request_id ~prompt =
  transaction store (fun () ->
      match stale_runtime_reason store target with
      | Some reason -> Error reason
      | None ->
          Ok
            (accept_command_unlocked ?action ?content ?images ?resources store
               ~command_id ~request_id ~prompt))

let command_content store command_id =
  with_statement store.db "SELECT content FROM commands WHERE command_id = ?"
    (fun statement ->
      bind_text statement 1 command_id;
      match Sqlite3.step statement with
      | Sqlite3.Rc.ROW -> Some (Sqlite3.column_text statement 0)
      | Sqlite3.Rc.DONE -> None
      | rc ->
          fail_rc "read command content" rc;
          None)

let clear_command_content store ~command_id =
  with_statement store.db
    "UPDATE commands SET content = '[]' WHERE command_id = ?" (fun statement ->
      bind_text statement 1 command_id;
      expect_done "clear command content" statement)

let update_command_state store ~command_id state =
  with_statement store.db
    "UPDATE commands SET state = ?, updated_at = ? WHERE command_id = ?"
    (fun statement ->
      bind_text statement 1 (command_state_to_string state);
      bind_float statement 2 (Unix.gettimeofday ());
      bind_text statement 3 command_id;
      expect_done "update command" statement)

let recover_targeted_text_command ?(discard_cleared_attachments = false) store
    ~target ~command_id ~action =
  transaction store (fun () ->
      match stale_runtime_reason store target with
      | Some reason -> Error reason
      | None -> (
          match find_command_record store command_id with
          | None -> Error "unknown command identity"
          | Some (prompt, content, state) -> (
              if state <> Ambiguous then Ok { state; duplicate = true; prompt }
              else
                match command_acceptance store command_id with
                | None -> Error "command acceptance metadata is unavailable"
                | Some acceptance ->
                    let open Yojson.Safe.Util in
                    let image_count = member "imageCount" acceptance in
                    let resource_count = member "resourceCount" acceptance in
                    let has_cleared_attachments =
                      image_count <> `Int 0 || resource_count <> `Int 0
                    in
                    if not (String.equal content "[]") then
                      Error "ambiguous command content has not been cleared"
                    else if
                      has_cleared_attachments && not discard_cleared_attachments
                    then
                      Error
                        "recovery requires explicit acknowledgement of cleared \
                         attachments"
                    else (
                      update_command_state store ~command_id Accepted;
                      ignore
                        (append_event store ~kind:"command.recovered"
                           ~payload:
                             (`Assoc
                                [
                                  ("commandId", `String command_id);
                                  ("action", `String action);
                                  ( "reason",
                                    `String
                                      "operator recovered an interrupted or \
                                       lost queued command" );
                                  ( "discardedClearedAttachments",
                                    `Bool has_cleared_attachments );
                                  ("discardedImageCount", image_count);
                                  ("discardedResourceCount", resource_count);
                                ]));
                      Ok { state = Accepted; duplicate = false; prompt }))))

let write_command_state store ~command_id state =
  update_command_state store ~command_id state;
  (match state with
  | Completed | Cancelled | Ambiguous | Rejected ->
      clear_command_content store ~command_id
  | Received | Accepted | Dispatched | Acknowledged -> ());
  ignore
    (append_event store ~kind:"command.state"
       ~payload:
         (`Assoc
            [
              ("commandId", `String command_id);
              ("state", `String (command_state_to_string state));
            ]))

let set_command_state store ~command_id state =
  transaction store (fun () -> write_command_state store ~command_id state)

let transition_command_state store ~command_id state =
  transaction store (fun () ->
      match find_command store command_id with
      | None -> Error "command does not exist"
      | Some current -> (
          match
            Piss_shared.Domain.transition_command_state ~from:current state
          with
          | Error _ as error -> error
          | Ok next ->
              write_command_state store ~command_id next;
              Ok ()))

let reconcile_ambiguous_command store ~command_id state =
  match Piss_shared.Domain.reconcile_ambiguous_command_state state with
  | Error _ as error -> error
  | Ok terminal ->
      transaction store (fun () ->
          with_statement store.db
            "UPDATE commands SET state = ?, updated_at = ? WHERE command_id = \
             ? AND state = 'ambiguous'" (fun statement ->
              bind_text statement 1 (command_state_to_string terminal);
              bind_float statement 2 (Unix.gettimeofday ());
              bind_text statement 3 command_id;
              expect_done "reconcile ambiguous command response" statement);
          if Sqlite3.changes store.db = 0 then Ok false
          else (
            clear_command_content store ~command_id;
            ignore
              (append_event store ~kind:"command.state"
                 ~payload:
                   (`Assoc
                      [
                        ("commandId", `String command_id);
                        ("state", `String (command_state_to_string terminal));
                        ("reconciledLateResponse", `Bool true);
                      ]));
            Ok true))

(* Atomically transition a command only while it is still in an open state.
   Returns true if the transition won the race against any concurrent state
   writer; false if the command already reached a terminal state. The caller
   must use this whenever it cannot otherwise observe that a harness response
   has landed (for example, the dispatch-timeout watcher). *)
let try_set_command_state_if_open store ~command_id state =
  transaction store (fun () ->
      match find_command store command_id with
      | None -> false
      | Some current when command_state_is_terminal current -> false
      | Some current -> (
          match
            Piss_shared.Domain.transition_command_state ~from:current state
          with
          | Error _ -> false
          | Ok next ->
              let now = Unix.gettimeofday () in
              let updated =
                with_statement store.db
                  "UPDATE commands SET state = ?, updated_at = ? WHERE \
                   command_id = ? AND state = ?" (fun statement ->
                    bind_text statement 1 (command_state_to_string next);
                    bind_float statement 2 now;
                    bind_text statement 3 command_id;
                    bind_text statement 4 (command_state_to_string current);
                    match Sqlite3.step statement with
                    | Sqlite3.Rc.DONE -> Sqlite3.changes store.db
                    | rc ->
                        fail_rc "try-set command state" rc;
                        0)
              in
              let claimed = updated > 0 in
              if claimed then (
                (match next with
                | Completed | Cancelled | Ambiguous | Rejected ->
                    clear_command_content store ~command_id
                | Received | Accepted | Dispatched | Acknowledged -> ());
                ignore
                  (append_event store ~kind:"command.state"
                     ~payload:
                       (`Assoc
                          [
                            ("commandId", `String command_id);
                            ("state", `String (command_state_to_string next));
                          ])));
              claimed))

let incomplete_command_ids store =
  with_statement store.db
    "SELECT command_id FROM commands WHERE state IN ('accepted', 'dispatched', \
     'acknowledged') ORDER BY created_at ASC" (fun statement ->
      let rec collect ids =
        match Sqlite3.step statement with
        | Sqlite3.Rc.ROW -> collect (Sqlite3.column_text statement 0 :: ids)
        | Sqlite3.Rc.DONE -> List.rev ids
        | rc ->
            fail_rc "list incomplete commands" rc;
            List.rev ids
      in
      collect [])

let dispatched_commands store =
  with_statement store.db
    "SELECT command_id, created_at FROM commands WHERE state IN ('dispatched', \
     'accepted', 'acknowledged') ORDER BY created_at ASC" (fun statement ->
      let rec collect rows =
        match Sqlite3.step statement with
        | Sqlite3.Rc.ROW ->
            let command_id = Sqlite3.column_text statement 0 in
            let created_at = Sqlite3.column_double statement 1 in
            collect ((command_id, created_at) :: rows)
        | Sqlite3.Rc.DONE -> List.rev rows
        | rc ->
            fail_rc "list dispatched commands" rc;
            List.rev rows
      in
      collect [])

let reconcile_incomplete_commands store =
  transaction store (fun () ->
      let command_ids = incomplete_command_ids store in
      List.iter
        (fun command_id ->
          update_command_state store ~command_id Ambiguous;
          clear_command_content store ~command_id;
          ignore
            (append_event store ~kind:"command.reconciled"
               ~payload:
                 (`Assoc
                    [
                      ("commandId", `String command_id);
                      ("state", `String "ambiguous");
                      ("reason", `String "worker restarted before completion");
                    ])))
        command_ids;
      command_ids)

let permission_request_id payload =
  match Yojson.Safe.Util.member "id" payload with
  | `String value -> Some value
  | `Int value -> Some (string_of_int value)
  | `Intlit value -> Some value
  | _ -> None

let reconcile_pending_permissions store =
  transaction store (fun () ->
      let pending = Hashtbl.create 8 in
      with_statement store.db
        "SELECT kind,payload FROM events WHERE kind IN \
         ('acp.permission.requested','acp.permission.resolved','acp.permission.cancelled','acp.permission.expired') \
         ORDER BY sequence" (fun statement ->
          let rec scan () =
            match Sqlite3.step statement with
            | Sqlite3.Rc.ROW ->
                let kind = Sqlite3.column_text statement 0 in
                let payload =
                  Sqlite3.column_text statement 1 |> Yojson.Safe.from_string
                in
                let request_id =
                  if String.equal kind "acp.permission.requested" then
                    permission_request_id payload
                  else
                    match Yojson.Safe.Util.member "requestId" payload with
                    | `String value -> Some value
                    | _ -> None
                in
                Option.iter
                  (fun request_id ->
                    if String.equal kind "acp.permission.requested" then
                      Hashtbl.replace pending request_id ()
                    else Hashtbl.remove pending request_id)
                  request_id;
                scan ()
            | Sqlite3.Rc.DONE -> ()
            | rc -> fail_rc "reconcile pending permissions" rc
          in
          scan ());
      let request_ids =
        Hashtbl.to_seq_keys pending |> List.of_seq |> List.sort String.compare
      in
      (* TODO(tracer): Rebind durable ACP permission requests to a proven live
         harness request when ACP exposes a stable restart/rebind contract.
         Until then cancellation is fail-closed: an old request is never
         presented as actionable after the worker that could answer it has
         exited. *)
      List.iter
        (fun request_id ->
          ignore
            (append_event store ~kind:"acp.permission.cancelled"
               ~payload:
                 (`Assoc
                    [
                      ("requestId", `String request_id);
                      ( "reason",
                        `String "worker restarted before permission resolution"
                      );
                      ("restartAmbiguous", `Bool true);
                    ])))
        request_ids;
      request_ids)

let command_acceptance_sequence store command_id =
  with_statement store.db
    "SELECT acceptance_sequence FROM commands WHERE command_id = ?"
    (fun statement ->
      bind_text statement 1 command_id;
      match Sqlite3.step statement with
      | Sqlite3.Rc.ROW -> Some (Sqlite3.column_int64 statement 0)
      | Sqlite3.Rc.DONE -> None
      | rc ->
          fail_rc "read command acceptance sequence" rc;
          None)

let reconcile_ambiguous_responses store =
  transaction store (fun () ->
      let responses =
        with_statement store.db
          "SELECT sequence,payload FROM events WHERE kind = 'acp.response' \
           ORDER BY sequence" (fun statement ->
            let rec collect responses =
              match Sqlite3.step statement with
              | Sqlite3.Rc.ROW ->
                  let sequence = Sqlite3.column_int64 statement 0 in
                  let payload =
                    Sqlite3.column_text statement 1 |> Yojson.Safe.from_string
                  in
                  let open Yojson.Safe.Util in
                  let response =
                    match member "id" payload with
                    | `String acp_request_id -> (
                        match
                          Piss_shared.Acp.command_id_of_request_id
                            acp_request_id
                        with
                        | None -> None
                        | Some command_id -> (
                            match
                              (member "error" payload, member "result" payload)
                            with
                            | (`Assoc _ | `String _), _ ->
                                Some (sequence, command_id, Rejected)
                            | _, `Assoc result ->
                                let state =
                                  if
                                    member "stopReason" (`Assoc result)
                                    = `String "cancelled"
                                  then Cancelled
                                  else Completed
                                in
                                Some (sequence, command_id, state)
                            | _ -> None))
                    | _ -> None
                  in
                  collect
                    (Option.fold ~none:responses
                       ~some:(fun value -> value :: responses)
                       response)
              | Sqlite3.Rc.DONE -> List.rev responses
              | rc ->
                  fail_rc "list ACP command responses" rc;
                  List.rev responses
            in
            collect [])
      in
      List.filter_map
        (fun (response_sequence, command_id, state) ->
          if
            find_command store command_id = Some Ambiguous
            &&
            match command_acceptance_sequence store command_id with
            | Some acceptance_sequence ->
                acceptance_sequence > 0L
                && response_sequence > acceptance_sequence
            | None -> false
          then (
            update_command_state store ~command_id state;
            ignore
              (append_event store ~kind:"command.reconciled"
                 ~payload:
                   (`Assoc
                      [
                        ("commandId", `String command_id);
                        ("state", `String (command_state_to_string state));
                        ( "reason",
                          `String "durable ACP response arrived after ambiguity"
                        );
                      ]));
            Some command_id)
          else None)
        responses)
