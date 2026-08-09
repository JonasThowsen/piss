open Piss_shared.Domain

exception Store_error of string

type t = { db : Sqlite3.db; session_id : session_id; worker_id : worker_id }

let _ = fun (s : t) -> ignore (s.session_id, s.worker_id)

type accepted_command = { state : command_state; duplicate : bool }

let max_retained_events = 65_536
let max_retained_commands = 1024

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
    "command.dispatch_timeout";
    "acp.permission.requested";
    "acp.permission.resolved";
    "acp.permission.cancelled";
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
  with_statement db
    ("PRAGMA table_info(" ^ table ^ ")")
    (fun statement ->
      let rec search () =
        match Sqlite3.step statement with
        | Sqlite3.Rc.ROW ->
            String.equal (Sqlite3.column_text statement 1) column || search ()
        | Sqlite3.Rc.DONE -> false
        | rc ->
            fail_rc "inspect table columns" rc;
            false
      in
      search ())

let initialize db =
  exec db "PRAGMA journal_mode=WAL";
  exec db "PRAGMA synchronous=FULL";
  exec db "PRAGMA foreign_keys=ON";
  exec db "PRAGMA busy_timeout=5000";
  exec db
    "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT \
     NULL)";
  exec db
    "CREATE TABLE IF NOT EXISTS commands (command_id TEXT PRIMARY \
     KEY,request_id TEXT NOT NULL UNIQUE,prompt TEXT NOT NULL,content TEXT NOT \
     NULL DEFAULT '[]',state TEXT NOT NULL,created_at REAL NOT NULL,updated_at \
     REAL NOT NULL)";
  if not (table_has_column db "commands" "content") then
    exec db "ALTER TABLE commands ADD COLUMN content TEXT NOT NULL DEFAULT '[]'";
  exec db
    "CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY \
     AUTOINCREMENT,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at REAL \
     NOT NULL)";
  exec db "CREATE INDEX IF NOT EXISTS events_kind_idx ON events(kind, sequence)"

let open_ ~path ~session_id ~worker_id =
  let db = Sqlite3.db_open path in
  initialize db;
  { db; session_id; worker_id }

let close store =
  if not (Sqlite3.db_close store.db) then
    raise (Store_error "close database failed: database is busy")

let transaction store f =
  exec store.db "BEGIN IMMEDIATE";
  match f () with
  | result ->
      exec store.db "COMMIT";
      result
  | exception exn ->
      (try exec store.db "ROLLBACK" with _ -> ());
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
  let count = row_count store "events" in
  if count >= Int64.of_int max_retained_events then
    let predicate = retention_predicate retained_event_kinds in
    exec store.db
      ("DELETE FROM events WHERE sequence IN (SELECT sequence FROM events \
        WHERE " ^ predicate ^ " ORDER BY sequence ASC LIMIT 1024)")

let append_event store ~kind ~(payload : Yojson.Safe.t) =
  compact_events_if_needed store;
  let count = row_count store "events" in
  let predicate = retention_predicate retained_event_kinds in
  let retained_count =
    scalar_int64 store ~operation:"count retained events"
      ("SELECT COUNT(*) FROM events WHERE " ^ predicate)
  in
  if
    count >= Int64.of_int max_retained_events
    && retained_count >= Int64.of_int max_retained_events
  then
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
  let sequence = Sqlite3.last_insert_rowid store.db in
  { sequence; kind; payload; created_at }

let list_events store ~after ~limit =
  with_statement store.db
    "SELECT sequence, kind, payload, created_at FROM events WHERE sequence > ? \
     ORDER BY sequence ASC LIMIT ?" (fun statement ->
      bind_int64 statement 1 after;
      fail_rc "bind limit" (Sqlite3.bind_int statement 2 limit);
      let rec collect events =
        match Sqlite3.step statement with
        | Sqlite3.Rc.ROW ->
            let payload =
              Sqlite3.column_text statement 2 |> Yojson.Safe.from_string
            in
            let event =
              {
                sequence = Sqlite3.column_int64 statement 0;
                kind = Sqlite3.column_text statement 1;
                payload;
                created_at = Sqlite3.column_double statement 3;
              }
            in
            collect (event :: events)
        | Sqlite3.Rc.DONE -> List.rev events
        | rc ->
            fail_rc "list events" rc;
            List.rev events
      in
      collect [])

let list_events_before store ~before ~limit =
  with_statement store.db
    "SELECT sequence, kind, payload, created_at FROM events WHERE sequence < ? \
     ORDER BY sequence DESC LIMIT ?" (fun statement ->
      bind_int64 statement 1 before;
      fail_rc "bind limit" (Sqlite3.bind_int statement 2 limit);
      let rec collect events =
        match Sqlite3.step statement with
        | Sqlite3.Rc.ROW ->
            let event =
              {
                sequence = Sqlite3.column_int64 statement 0;
                kind = Sqlite3.column_text statement 1;
                payload =
                  Sqlite3.column_text statement 2 |> Yojson.Safe.from_string;
                created_at = Sqlite3.column_double statement 3;
              }
            in
            collect (event :: events)
        | Sqlite3.Rc.DONE -> events
        | rc ->
            fail_rc "list events before cursor" rc;
            events
      in
      collect [])

let list_recent_events store ~limit =
  with_statement store.db
    "SELECT sequence, kind, payload, created_at FROM events ORDER BY sequence \
     DESC LIMIT ?" (fun statement ->
      fail_rc "bind limit" (Sqlite3.bind_int statement 1 limit);
      let rec collect events =
        match Sqlite3.step statement with
        | Sqlite3.Rc.ROW ->
            let event =
              {
                sequence = Sqlite3.column_int64 statement 0;
                kind = Sqlite3.column_text statement 1;
                payload =
                  Sqlite3.column_text statement 2 |> Yojson.Safe.from_string;
                created_at = Sqlite3.column_double statement 3;
              }
            in
            collect (event :: events)
        | Sqlite3.Rc.DONE -> events
        | rc ->
            fail_rc "list recent events" rc;
            events
      in
      collect [])

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

let accept_command ?(action = "prompt") ?(content = `List []) ?(images = [])
    ?(resources = []) store ~command_id ~request_id ~prompt =
  transaction store (fun () ->
      match find_command store command_id with
      | Some state -> { state; duplicate = true }
      | None ->
          if row_count store "commands" >= Int64.of_int max_retained_commands
          then
            raise
              (Store_error
                 (Printf.sprintf "command retention limit reached (%d)"
                    max_retained_commands));
          let now = Unix.gettimeofday () in
          with_statement store.db
            "INSERT INTO commands(command_id, request_id, prompt, content, \
             state, created_at, updated_at) VALUES (?, ?, ?, ?, 'accepted', ?, \
             ?)" (fun statement ->
              bind_text statement 1 command_id;
              bind_text statement 2 request_id;
              bind_text statement 3 prompt;
              bind_text statement 4 (Yojson.Safe.to_string content);
              bind_float statement 5 now;
              bind_float statement 6 now;
              expect_done "accept command" statement);
          ignore
            (append_event store ~kind:"command.accepted"
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
                    ]));
          { state = Accepted; duplicate = false })

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

let set_command_state store ~command_id state =
  transaction store (fun () ->
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
                ])))

(* Atomically transition a command only while it is still in an open state.
   Returns true if the transition won the race against any concurrent state
   writer; false if the command already reached a terminal state. The caller
   must use this whenever it cannot otherwise observe that a harness response
   has landed (for example, the dispatch-timeout watcher). *)
let try_set_command_state_if_open store ~command_id state =
  let updated =
    transaction store (fun () ->
        let now = Unix.gettimeofday () in
        with_statement store.db
          "UPDATE commands SET state = ?, updated_at = ? WHERE command_id = ? \
           AND state IN ('accepted', 'dispatched', 'acknowledged')"
          (fun statement ->
            bind_text statement 1 (command_state_to_string state);
            bind_float statement 2 now;
            bind_text statement 3 command_id;
            match Sqlite3.step statement with
            | Sqlite3.Rc.DONE -> Sqlite3.changes store.db
            | rc ->
                fail_rc "try-set command state" rc;
                0))
  in
  let claimed = updated > 0 in
  (if claimed then
     match state with
     | Completed | Cancelled | Ambiguous | Rejected ->
         clear_command_content store ~command_id
     | Received | Accepted | Dispatched | Acknowledged ->
         ();
         ignore
           (append_event store ~kind:"command.state"
              ~payload:
                (`Assoc
                   [
                     ("commandId", `String command_id);
                     ("state", `String (command_state_to_string state));
                   ])));
  claimed

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
