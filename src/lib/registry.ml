exception Registry_error = Registry_support.Registry_error

type workspace = Registry_support.workspace = {
  id : string;
  name : string;
  root : string;
  created_at : float;
}

type session = Registry_support.session = {
  id : string;
  title : string;
  harness : string;
  created_at : float;
  archived_at : float option;
  broker_token : string;
  workspace_id : string;
}

type peer_request = Registry_support.peer_request = {
  id : string;
  source_id : string;
  target_id : string;
  prompt : string;
  command_id : string;
  start_sequence : int64;
  state : string;
  response : string option;
}

type peer_subscription = Registry_support.peer_subscription = {
  id : string;
  source_id : string;
  request_ids : string list;
  wait_for : string;
  command_id : string;
  state : string;
}

type session_creation = Registry_support.session_creation = {
  id : string;
  source_id : string;
  workspace_id : string;
  title : string;
  harness : string;
  session_id : string;
  state : string;
  error : string option;
  updated_at : float;
}

type t = Registry_support.t = { db : Sqlite3.db }

open Registry_support

let open_ ~path =
  let db = Sqlite3.db_open path in
  initialize db;
  with_statement db "SELECT id FROM sessions WHERE broker_token = ''"
    (fun statement ->
      let rec collect ids =
        match Sqlite3.step statement with
        | Sqlite3.Rc.ROW -> collect (Sqlite3.column_text statement 0 :: ids)
        | Sqlite3.Rc.DONE -> ids
        | rc ->
            fail_rc "list sessions without broker tokens" rc;
            ids
      in
      collect [])
  |> List.iter (fun id ->
      with_statement db "UPDATE sessions SET broker_token = ? WHERE id = ?"
        (fun statement ->
          bind_text statement 1 (random_secret ());
          bind_text statement 2 id;
          expect_done "assign broker token" statement));
  { db }

let close registry =
  if not (Sqlite3.db_close registry.db) then
    raise (Registry_error "close database failed: database is busy")

let transaction registry f =
  exec registry.db "BEGIN IMMEDIATE";
  match f () with
  | result ->
      exec registry.db "COMMIT";
      result
  | exception exn ->
      (try exec registry.db "ROLLBACK" with _ -> ());
      raise exn

let write_workspace registry ~id ~name ~root =
  with_statement registry.db
    "INSERT INTO workspaces(id,name,root,created_at) VALUES (?,?,?,?) ON \
     CONFLICT(id) DO UPDATE SET name=excluded.name,root=excluded.root"
    (fun statement ->
      bind_text statement 1 id;
      bind_text statement 2 name;
      bind_text statement 3 root;
      bind_float statement 4 (Unix.gettimeofday ());
      expect_done "upsert workspace" statement)

let upsert_workspace registry ~id ~name ~root =
  with_statement registry.db "DELETE FROM workspace_removals WHERE id = ?"
    (fun statement ->
      bind_text statement 1 id;
      expect_done "clear workspace removal" statement);
  write_workspace registry ~id ~name ~root

let configure_workspace registry ~id ~name ~root =
  let removed =
    with_statement registry.db "SELECT 1 FROM workspace_removals WHERE id = ?"
      (fun statement ->
        bind_text statement 1 id;
        match Sqlite3.step statement with
        | Sqlite3.Rc.ROW -> true
        | Sqlite3.Rc.DONE -> false
        | rc ->
            fail_rc "inspect workspace removal" rc;
            true)
  in
  if not removed then write_workspace registry ~id ~name ~root

let find_workspace_by_root registry root =
  with_statement registry.db
    "SELECT id,name,root,created_at FROM workspaces WHERE root = ?"
    (fun statement ->
      bind_text statement 1 root;
      match Sqlite3.step statement with
      | Sqlite3.Rc.ROW -> Some (workspace_of_statement statement)
      | Sqlite3.Rc.DONE -> None
      | rc ->
          fail_rc "find workspace by root" rc;
          None)

let list_workspaces registry =
  with_statement registry.db
    "SELECT id,name,root,created_at FROM workspaces ORDER BY created_at ASC"
    (fun statement ->
      let rec collect workspaces =
        match Sqlite3.step statement with
        | Sqlite3.Rc.ROW ->
            collect (workspace_of_statement statement :: workspaces)
        | Sqlite3.Rc.DONE -> List.rev workspaces
        | rc ->
            fail_rc "list workspaces" rc;
            List.rev workspaces
      in
      collect [])

let find_workspace registry id =
  with_statement registry.db
    "SELECT id,name,root,created_at FROM workspaces WHERE id = ?"
    (fun statement ->
      bind_text statement 1 id;
      match Sqlite3.step statement with
      | Sqlite3.Rc.ROW -> Some (workspace_of_statement statement)
      | Sqlite3.Rc.DONE -> None
      | rc ->
          fail_rc "find workspace" rc;
          None)

let workspace_session_count registry id =
  with_statement registry.db
    "SELECT COUNT(*) FROM sessions WHERE workspace_id = ?" (fun statement ->
      bind_text statement 1 id;
      match Sqlite3.step statement with
      | Sqlite3.Rc.ROW -> Int64.to_int (Sqlite3.column_int64 statement 0)
      | rc ->
          fail_rc "count workspace sessions" rc;
          0)

let remove_workspace registry id =
  transaction registry (fun () ->
      with_statement registry.db
        "INSERT INTO workspace_removals(id,removed_at) VALUES (?,?) ON \
         CONFLICT(id) DO UPDATE SET removed_at=excluded.removed_at"
        (fun statement ->
          bind_text statement 1 id;
          bind_float statement 2 (Unix.gettimeofday ());
          expect_done "record workspace removal" statement);
      with_statement registry.db "DELETE FROM workspaces WHERE id = ?"
        (fun statement ->
          bind_text statement 1 id;
          expect_done "remove workspace" statement);
      Sqlite3.changes registry.db > 0)

let source_is_active registry source_id =
  with_statement registry.db
    "SELECT 1 FROM sessions WHERE id = ? AND archived_at IS NULL AND \
     finishing_at IS NULL" (fun statement ->
      bind_text statement 1 source_id;
      match Sqlite3.step statement with
      | Sqlite3.Rc.ROW -> true
      | Sqlite3.Rc.DONE -> false
      | rc ->
          fail_rc "check active source session" rc;
          false)

let accept_broker_workspace registry ~id ~source_id ~canonical_root
    ~workspace_id ~name =
  transaction registry (fun () ->
      let existing =
        with_statement registry.db
          "SELECT source_id,canonical_root,workspace_id FROM \
           broker_workspace_requests WHERE id = ?" (fun statement ->
            bind_text statement 1 id;
            match Sqlite3.step statement with
            | Sqlite3.Rc.ROW ->
                Some
                  ( Sqlite3.column_text statement 0,
                    Sqlite3.column_text statement 1,
                    Sqlite3.column_text statement 2 )
            | Sqlite3.Rc.DONE -> None
            | rc ->
                fail_rc "find broker workspace request" rc;
                None)
      in
      match existing with
      | Some (stored_source, stored_root, stored_workspace)
        when String.equal stored_source source_id
             && String.equal stored_root canonical_root -> (
          match find_workspace registry stored_workspace with
          | Some workspace -> Ok (workspace, true)
          | None -> Error "registered workspace no longer exists")
      | Some _ -> Error "requestId was already used with different input"
      | None when not (source_is_active registry source_id) ->
          Error "source session is no longer active"
      | None ->
          let workspace =
            match find_workspace_by_root registry canonical_root with
            | Some workspace -> workspace
            | None ->
                with_statement registry.db
                  "INSERT INTO workspaces(id,name,root,created_at) VALUES \
                   (?,?,?,?)" (fun statement ->
                    bind_text statement 1 workspace_id;
                    bind_text statement 2 name;
                    bind_text statement 3 canonical_root;
                    bind_float statement 4 (Unix.gettimeofday ());
                    expect_done "register broker workspace" statement);
                Option.get (find_workspace registry workspace_id)
          in
          with_statement registry.db
            "INSERT INTO \
             broker_workspace_requests(id,source_id,canonical_root,workspace_id,created_at) \
             VALUES (?,?,?,?,?)" (fun statement ->
              bind_text statement 1 id;
              bind_text statement 2 source_id;
              bind_text statement 3 canonical_root;
              bind_text statement 4 workspace.id;
              bind_float statement 5 (Unix.gettimeofday ());
              expect_done "accept broker workspace request" statement);
          Ok (workspace, false))

let catalog_revision registry =
  with_statement registry.db
    "SELECT revision FROM catalog_state WHERE singleton = 1" (fun statement ->
      match Sqlite3.step statement with
      | Sqlite3.Rc.ROW -> Sqlite3.column_int64 statement 0
      | rc ->
          fail_rc "read catalog revision" rc;
          0L)

let assign_unscoped_sessions registry workspace_id =
  with_statement registry.db
    "UPDATE sessions SET workspace_id = ? WHERE workspace_id = ''"
    (fun statement ->
      bind_text statement 1 workspace_id;
      expect_done "assign legacy session workspace" statement)

let insert registry ~id ~title ~harness ~workspace_id =
  let created_at = Unix.gettimeofday () in
  let broker_token = random_secret () in
  with_statement registry.db
    "INSERT INTO \
     sessions(id,title,harness,created_at,archived_at,broker_token,workspace_id) \
     VALUES (?,?,?,?,NULL,?,?)" (fun statement ->
      bind_text statement 1 id;
      bind_text statement 2 title;
      bind_text statement 3 harness;
      bind_float statement 4 created_at;
      bind_text statement 5 broker_token;
      bind_text statement 6 workspace_id;
      expect_done "create session" statement);
  {
    id;
    title;
    harness;
    created_at;
    archived_at = None;
    broker_token;
    workspace_id;
  }

let find_session registry id =
  with_statement registry.db
    "SELECT id,title,harness,created_at,archived_at,broker_token,workspace_id \
     FROM sessions WHERE id = ?" (fun statement ->
      bind_text statement 1 id;
      match Sqlite3.step statement with
      | Sqlite3.Rc.ROW -> Some (session_of_statement statement)
      | Sqlite3.Rc.DONE -> None
      | rc ->
          fail_rc "find session" rc;
          None)

let find_session_creation registry id =
  with_statement registry.db
    "SELECT \
     id,source_id,workspace_id,title,harness,session_id,state,error,updated_at \
     FROM broker_session_requests WHERE id = ?" (fun statement ->
      bind_text statement 1 id;
      match Sqlite3.step statement with
      | Sqlite3.Rc.ROW -> Some (session_creation_of_statement statement)
      | Sqlite3.Rc.DONE -> None
      | rc ->
          fail_rc "find broker session request" rc;
          None)

let active_count_sql registry =
  with_statement registry.db
    "SELECT COUNT(*) FROM sessions WHERE archived_at IS NULL" (fun statement ->
      match Sqlite3.step statement with
      | Sqlite3.Rc.ROW -> Int64.to_int (Sqlite3.column_int64 statement 0)
      | rc ->
          fail_rc "count active sessions" rc;
          0)

let accept_session_creation registry ~id ~source_id ~workspace_id ~title
    ~harness ~session_id ~max_active_sessions =
  transaction registry (fun () ->
      match find_session_creation registry id with
      | Some request
        when String.equal request.source_id source_id
             && String.equal request.workspace_id workspace_id
             && String.equal request.title title
             && String.equal request.harness harness -> (
          match find_session registry request.session_id with
          | Some session -> Ok (request, session, true)
          | None -> Error "created session metadata is missing")
      | Some _ -> Error "requestId was already used with different input"
      | None when not (source_is_active registry source_id) ->
          Error "source session is no longer active"
      | None when Option.is_none (find_workspace registry workspace_id) ->
          Error "requested workspace is not registered"
      | None when active_count_sql registry >= max_active_sessions ->
          Error "active session limit reached"
      | None ->
          let now = Unix.gettimeofday () in
          let session =
            insert registry ~id:session_id ~title ~harness ~workspace_id
          in
          with_statement registry.db
            "INSERT INTO \
             broker_session_requests(id,source_id,workspace_id,title,harness,session_id,state,error,created_at,updated_at) \
             VALUES (?,?,?,?,?,?,'pending',NULL,?,?)" (fun statement ->
              bind_text statement 1 id;
              bind_text statement 2 source_id;
              bind_text statement 3 workspace_id;
              bind_text statement 4 title;
              bind_text statement 5 harness;
              bind_text statement 6 session_id;
              bind_float statement 7 now;
              bind_float statement 8 now;
              expect_done "accept broker session request" statement);
          Ok (Option.get (find_session_creation registry id), session, false))

let claim_session_creation ?reclaim_before registry id =
  let condition =
    match reclaim_before with
    | None -> "state = 'pending'"
    | Some _ -> "state = 'pending' OR (state = 'launching' AND updated_at <= ?)"
  in
  with_statement registry.db
    ("UPDATE broker_session_requests SET state = 'launching',error = \
      NULL,updated_at = ? WHERE id = ? AND (" ^ condition ^ ")")
    (fun statement ->
      bind_float statement 1 (Unix.gettimeofday ());
      bind_text statement 2 id;
      Option.iter (bind_float statement 3) reclaim_before;
      expect_done "claim broker session launch" statement);
  Sqlite3.changes registry.db > 0

let mark_session_creation_active registry id =
  with_statement registry.db
    "UPDATE broker_session_requests SET state = 'active',error = \
     NULL,updated_at = ? WHERE id = ? AND state = 'launching'" (fun statement ->
      bind_float statement 1 (Unix.gettimeofday ());
      bind_text statement 2 id;
      expect_done "complete broker session creation" statement);
  Sqlite3.changes registry.db > 0

let mark_session_creation_cleanup registry id message =
  with_statement registry.db
    "UPDATE broker_session_requests SET state = 'cleanup',error = ?,updated_at \
     = ? WHERE id = ? AND state IN ('pending','launching')" (fun statement ->
      bind_text statement 1 message;
      bind_float statement 2 (Unix.gettimeofday ());
      bind_text statement 3 id;
      expect_done "record broker session cleanup" statement);
  Sqlite3.changes registry.db > 0

let mark_session_creation_failed registry id message =
  with_statement registry.db
    "UPDATE broker_session_requests SET state = 'failed',error = ?,updated_at \
     = ? WHERE id = ? AND state IN ('pending','launching','cleanup')"
    (fun statement ->
      bind_text statement 1 message;
      bind_float statement 2 (Unix.gettimeofday ());
      bind_text statement 3 id;
      expect_done "fail broker session creation" statement);
  Sqlite3.changes registry.db > 0

let session_created_by registry ~source_id ~session_id =
  with_statement registry.db
    "SELECT 1 FROM broker_session_requests WHERE source_id = ? AND session_id \
     = ? AND state = 'active'" (fun statement ->
      bind_text statement 1 source_id;
      bind_text statement 2 session_id;
      match Sqlite3.step statement with
      | Sqlite3.Rc.ROW -> true
      | Sqlite3.Rc.DONE -> false
      | rc ->
          fail_rc "check broker session ownership" rc;
          false)

let has_open_session_work registry ~session_id =
  with_statement registry.db
    "SELECT (EXISTS (SELECT 1 FROM peer_requests WHERE (source_id = ? OR \
     target_id = ?) AND state IN \
     ('accepted','queued','dispatching','dispatched'))) OR (EXISTS (SELECT 1 \
     FROM peer_subscriptions WHERE source_id = ? AND state IN \
     ('pending','dispatching')))" (fun statement ->
      bind_text statement 1 session_id;
      bind_text statement 2 session_id;
      bind_text statement 3 session_id;
      match Sqlite3.step statement with
      | Sqlite3.Rc.ROW -> Sqlite3.column_int statement 0 <> 0
      | Sqlite3.Rc.DONE -> false
      | rc ->
          fail_rc "check open session work" rc;
          false)

let cleanup_recommended registry ~source_id ~session_id =
  session_created_by registry ~source_id ~session_id
  && (not (has_open_session_work registry ~session_id))
  && with_statement registry.db
       "SELECT 1 FROM peer_requests WHERE source_id = ? AND target_id = ? AND \
        state IN ('completed','failed') LIMIT 1" (fun statement ->
         bind_text statement 1 source_id;
         bind_text statement 2 session_id;
         match Sqlite3.step statement with
         | Sqlite3.Rc.ROW -> true
         | Sqlite3.Rc.DONE -> false
         | rc ->
             fail_rc "check completed work for session cleanup" rc;
             false)

let claim_session_finish registry ~source_id ~session_id =
  transaction registry (fun () ->
      if not (session_created_by registry ~source_id ~session_id) then
        Error "only the creating orchestrator may finish this session"
      else if has_open_session_work registry ~session_id then
        Error
          "session still has unfinished peer work; collect every response \
           before finishing it"
      else (
        with_statement registry.db
          "UPDATE sessions SET finishing_at = ? WHERE id = ? AND archived_at \
           IS NULL AND finishing_at IS NULL" (fun statement ->
            bind_float statement 1 (Unix.gettimeofday ());
            bind_text statement 2 session_id;
            expect_done "claim session finish" statement);
        if Sqlite3.changes registry.db = 1 then Ok ()
        else Error "session finish is already in progress or archived"))

let cancel_session_finish registry session_id =
  with_statement registry.db
    "UPDATE sessions SET finishing_at = NULL WHERE id = ? AND archived_at IS \
     NULL AND finishing_at IS NOT NULL" (fun statement ->
      bind_text statement 1 session_id;
      expect_done "cancel session finish" statement);
  Sqlite3.changes registry.db > 0

let list_finishing_sessions registry =
  with_statement registry.db
    "SELECT id,title,harness,created_at,archived_at,broker_token,workspace_id \
     FROM sessions WHERE archived_at IS NULL AND finishing_at IS NOT NULL \
     ORDER BY created_at ASC" (fun statement ->
      let rec collect sessions =
        match Sqlite3.step statement with
        | Sqlite3.Rc.ROW -> collect (session_of_statement statement :: sessions)
        | Sqlite3.Rc.DONE -> List.rev sessions
        | rc ->
            fail_rc "list finishing sessions" rc;
            List.rev sessions
      in
      collect [])

let list_incomplete_session_creations registry =
  with_statement registry.db
    "SELECT \
     id,source_id,workspace_id,title,harness,session_id,state,error,updated_at \
     FROM broker_session_requests WHERE state IN \
     ('pending','launching','cleanup') ORDER BY created_at ASC"
    (fun statement ->
      let rec collect requests =
        match Sqlite3.step statement with
        | Sqlite3.Rc.ROW ->
            collect (session_creation_of_statement statement :: requests)
        | Sqlite3.Rc.DONE -> List.rev requests
        | rc ->
            fail_rc "list incomplete broker session requests" rc;
            List.rev requests
      in
      collect [])

let list registry ~include_archived =
  let sql =
    if include_archived then
      "SELECT \
       id,title,harness,created_at,archived_at,broker_token,workspace_id FROM \
       sessions ORDER BY created_at ASC"
    else
      "SELECT \
       id,title,harness,created_at,archived_at,broker_token,workspace_id FROM \
       sessions WHERE archived_at IS NULL AND finishing_at IS NULL ORDER BY \
       created_at ASC"
  in
  with_statement registry.db sql (fun statement ->
      let rec collect sessions =
        match Sqlite3.step statement with
        | Sqlite3.Rc.ROW -> collect (session_of_statement statement :: sessions)
        | Sqlite3.Rc.DONE -> List.rev sessions
        | rc ->
            fail_rc "list sessions" rc;
            List.rev sessions
      in
      collect [])

let find = find_session

let find_active registry id =
  with_statement registry.db
    "SELECT id,title,harness,created_at,archived_at,broker_token,workspace_id \
     FROM sessions WHERE id = ? AND archived_at IS NULL AND finishing_at IS \
     NULL" (fun statement ->
      bind_text statement 1 id;
      match Sqlite3.step statement with
      | Sqlite3.Rc.ROW -> Some (session_of_statement statement)
      | Sqlite3.Rc.DONE -> None
      | rc ->
          fail_rc "find active session" rc;
          None)

let find_active_by_token registry token =
  with_statement registry.db
    "SELECT id,title,harness,created_at,archived_at,broker_token,workspace_id \
     FROM sessions WHERE broker_token = ? AND archived_at IS NULL AND \
     finishing_at IS NULL" (fun statement ->
      bind_text statement 1 token;
      match Sqlite3.step statement with
      | Sqlite3.Rc.ROW -> Some (session_of_statement statement)
      | Sqlite3.Rc.DONE -> None
      | rc ->
          fail_rc "find broker session" rc;
          None)

let find_peer_request registry id =
  with_statement registry.db
    "SELECT \
     id,source_id,target_id,prompt,command_id,start_sequence,state,response \
     FROM peer_requests WHERE id = ?" (fun statement ->
      bind_text statement 1 id;
      match Sqlite3.step statement with
      | Sqlite3.Rc.ROW -> Some (peer_request_of_statement statement)
      | Sqlite3.Rc.DONE -> None
      | rc ->
          fail_rc "find peer request" rc;
          None)

let accept_peer_request registry ~id ~source_id ~target_id ~prompt ~command_id
    ~start_sequence =
  match find_peer_request registry id with
  | Some request -> (request, true)
  | None ->
      let now = Unix.gettimeofday () in
      with_statement registry.db
        "INSERT INTO \
         peer_requests(id,source_id,target_id,prompt,command_id,start_sequence,state,response,managed_reconciliation,created_at,updated_at) \
         SELECT ?,?,?,?,?,?,'accepted',NULL,1,?,? WHERE EXISTS (SELECT 1 FROM \
         sessions WHERE id = ? AND archived_at IS NULL AND finishing_at IS \
         NULL) AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND archived_at \
         IS NULL AND finishing_at IS NULL)" (fun statement ->
          bind_text statement 1 id;
          bind_text statement 2 source_id;
          bind_text statement 3 target_id;
          bind_text statement 4 prompt;
          bind_text statement 5 command_id;
          bind_int64 statement 6 start_sequence;
          bind_float statement 7 now;
          bind_float statement 8 now;
          bind_text statement 9 source_id;
          bind_text statement 10 target_id;
          expect_done "accept peer request" statement);
      if Sqlite3.changes registry.db = 0 then
        invalid_arg "source or target session is no longer active";
      (Option.get (find_peer_request registry id), false)

let list_peer_requests registry ~source_id =
  with_statement registry.db
    "SELECT \
     id,source_id,target_id,prompt,command_id,start_sequence,state,response \
     FROM peer_requests WHERE source_id = ? ORDER BY created_at ASC"
    (fun statement ->
      bind_text statement 1 source_id;
      let rec collect requests =
        match Sqlite3.step statement with
        | Sqlite3.Rc.ROW ->
            collect (peer_request_of_statement statement :: requests)
        | Sqlite3.Rc.DONE -> List.rev requests
        | rc ->
            fail_rc "list peer requests" rc;
            List.rev requests
      in
      collect [])

let has_open_peer_work registry ~source_id =
  with_statement registry.db
    "SELECT (EXISTS (SELECT 1 FROM peer_requests WHERE source_id = ? AND \
     managed_reconciliation = 1 AND state IN \
     ('accepted','queued','dispatching','dispatched'))) OR (EXISTS (SELECT 1 \
     FROM peer_subscriptions WHERE source_id = ? AND state IN \
     ('pending','dispatching')))" (fun statement ->
      bind_text statement 1 source_id;
      bind_text statement 2 source_id;
      match Sqlite3.step statement with
      | Sqlite3.Rc.ROW -> Sqlite3.column_int statement 0 <> 0
      | Sqlite3.Rc.DONE -> false
      | rc ->
          fail_rc "check open peer work" rc;
          false)

let list_reconcilable_peer_requests registry ~limit =
  let now = Unix.gettimeofday () in
  with_statement registry.db
    "SELECT \
     id,source_id,target_id,prompt,command_id,start_sequence,state,response \
     FROM peer_requests WHERE managed_reconciliation = 1 AND (state = \
     'dispatched' OR (state IN ('accepted','queued') AND updated_at <= ?) OR \
     (state = 'dispatching' AND updated_at <= ?)) ORDER BY updated_at ASC \
     LIMIT ?" (fun statement ->
      bind_float statement 1 (now -. 1.);
      bind_float statement 2 (now -. 5.);
      fail_rc "bind reconcilable peer request limit"
        (Sqlite3.bind_int statement 3 limit);
      let rec collect requests =
        match Sqlite3.step statement with
        | Sqlite3.Rc.ROW ->
            collect (peer_request_of_statement statement :: requests)
        | Sqlite3.Rc.DONE -> List.rev requests
        | rc ->
            fail_rc "list reconcilable peer requests" rc;
            List.rev requests
      in
      collect [])

let touch_dispatched_peer_request registry id =
  with_statement registry.db
    "UPDATE peer_requests SET updated_at = ? WHERE id = ? AND state IN \
     ('dispatching','dispatched')" (fun statement ->
      bind_float statement 1 (Unix.gettimeofday ());
      bind_text statement 2 id;
      expect_done "touch dispatched peer request" statement)

let find_peer_subscription registry id =
  with_statement registry.db
    "SELECT id,source_id,request_ids,wait_for,command_id,state FROM \
     peer_subscriptions WHERE id = ?" (fun statement ->
      bind_text statement 1 id;
      match Sqlite3.step statement with
      | Sqlite3.Rc.ROW -> Some (peer_subscription_of_statement statement)
      | Sqlite3.Rc.DONE -> None
      | rc ->
          fail_rc "find peer subscription" rc;
          None)

let accept_peer_subscription registry ~id ~source_id ~request_ids ~wait_for
    ~command_id =
  match find_peer_subscription registry id with
  | Some subscription -> (subscription, true)
  | None ->
      let now = Unix.gettimeofday () in
      let request_ids_json =
        `List (List.map (fun value -> `String value) request_ids)
        |> Yojson.Safe.to_string
      in
      with_statement registry.db
        "INSERT INTO \
         peer_subscriptions(id,source_id,request_ids,wait_for,command_id,state,created_at,updated_at) \
         VALUES (?,?,?,?,?,'pending',?,?)" (fun statement ->
          bind_text statement 1 id;
          bind_text statement 2 source_id;
          bind_text statement 3 request_ids_json;
          bind_text statement 4 wait_for;
          bind_text statement 5 command_id;
          bind_float statement 6 now;
          bind_float statement 7 now;
          expect_done "accept peer subscription" statement);
      (Option.get (find_peer_subscription registry id), false)

let list_open_peer_subscriptions registry =
  with_statement registry.db
    "SELECT id,source_id,request_ids,wait_for,command_id,state FROM \
     peer_subscriptions WHERE state IN ('pending','dispatching') ORDER BY \
     created_at ASC" (fun statement ->
      let rec collect subscriptions =
        match Sqlite3.step statement with
        | Sqlite3.Rc.ROW ->
            collect (peer_subscription_of_statement statement :: subscriptions)
        | Sqlite3.Rc.DONE -> List.rev subscriptions
        | rc ->
            fail_rc "list open peer subscriptions" rc;
            List.rev subscriptions
      in
      collect [])

let mark_peer_subscription_dispatching registry id =
  with_statement registry.db
    "UPDATE peer_subscriptions SET state = 'dispatching',updated_at = ? WHERE \
     id = ? AND state = 'pending'" (fun statement ->
      bind_float statement 1 (Unix.gettimeofday ());
      bind_text statement 2 id;
      expect_done "mark peer subscription dispatching" statement)

let complete_peer_subscription registry id =
  with_statement registry.db
    "UPDATE peer_subscriptions SET state = 'delivered',updated_at = ? WHERE id \
     = ? AND state <> 'delivered'" (fun statement ->
      bind_float statement 1 (Unix.gettimeofday ());
      bind_text statement 2 id;
      expect_done "complete peer subscription" statement);
  Sqlite3.changes registry.db > 0

let mark_peer_dispatching registry id ~start_sequence =
  with_statement registry.db
    "UPDATE peer_requests SET state = 'dispatching',start_sequence = CASE WHEN \
     start_sequence = 0 THEN ? ELSE start_sequence END,updated_at = ? WHERE id \
     = ? AND state IN ('accepted','queued')" (fun statement ->
      bind_int64 statement 1 start_sequence;
      bind_float statement 2 (Unix.gettimeofday ());
      bind_text statement 3 id;
      expect_done "mark peer request dispatching" statement);
  Sqlite3.changes registry.db > 0

let mark_peer_dispatched registry id =
  with_statement registry.db
    "UPDATE peer_requests SET state = 'dispatched',response = NULL,updated_at \
     = ? WHERE id = ? AND state IN ('dispatching','dispatched')"
    (fun statement ->
      bind_float statement 1 (Unix.gettimeofday ());
      bind_text statement 2 id;
      expect_done "mark peer request dispatched" statement);
  Sqlite3.changes registry.db > 0

let requeue_peer_request registry id =
  with_statement registry.db
    "UPDATE peer_requests SET state = 'queued',response = NULL,updated_at = ? \
     WHERE id = ? AND state = 'dispatching'" (fun statement ->
      bind_float statement 1 (Unix.gettimeofday ());
      bind_text statement 2 id;
      expect_done "requeue peer request" statement);
  Sqlite3.changes registry.db > 0

let complete_peer_request registry id response =
  with_statement registry.db
    "UPDATE peer_requests SET state = 'completed',response = ?,updated_at = ? \
     WHERE id = ? AND state NOT IN ('completed','failed')" (fun statement ->
      bind_text statement 1 response;
      bind_float statement 2 (Unix.gettimeofday ());
      bind_text statement 3 id;
      expect_done "complete peer request" statement);
  Sqlite3.changes registry.db > 0

let fail_peer_request registry id message =
  with_statement registry.db
    "UPDATE peer_requests SET state = 'failed',response = ?,updated_at = ? \
     WHERE id = ? AND state NOT IN ('completed','failed')" (fun statement ->
      bind_text statement 1 message;
      bind_float statement 2 (Unix.gettimeofday ());
      bind_text statement 3 id;
      expect_done "fail peer request" statement);
  Sqlite3.changes registry.db > 0

let rename_session registry id title =
  with_statement registry.db "UPDATE sessions SET title = ? WHERE id = ?"
    (fun statement ->
      bind_text statement 1 title;
      bind_text statement 2 id;
      expect_done "rename session" statement);
  Sqlite3.changes registry.db > 0

let archive registry id =
  with_statement registry.db
    "UPDATE sessions SET archived_at = ?,finishing_at = NULL WHERE id = ? AND \
     archived_at IS NULL" (fun statement ->
      bind_float statement 1 (Unix.gettimeofday ());
      bind_text statement 2 id;
      expect_done "archive session" statement);
  Sqlite3.changes registry.db > 0

let restore registry id =
  with_statement registry.db
    "UPDATE sessions SET archived_at = NULL,finishing_at = NULL WHERE id = ? \
     AND archived_at IS NOT NULL" (fun statement ->
      bind_text statement 1 id;
      expect_done "restore session" statement);
  Sqlite3.changes registry.db > 0

let list_archived registry =
  list registry ~include_archived:true
  |> List.filter (fun session -> Option.is_some session.archived_at)

let peer_request_ids_for_session registry id =
  with_statement registry.db
    "SELECT id FROM peer_requests WHERE source_id = ? OR target_id = ?"
    (fun statement ->
      bind_text statement 1 id;
      bind_text statement 2 id;
      let rec collect request_ids =
        match Sqlite3.step statement with
        | Sqlite3.Rc.ROW ->
            collect (Sqlite3.column_text statement 0 :: request_ids)
        | Sqlite3.Rc.DONE -> request_ids
        | rc ->
            fail_rc "list peer requests for deleted session" rc;
            request_ids
      in
      collect [])

let delete_subscriptions_referencing registry request_ids =
  if request_ids <> [] then
    let request_ids = List.sort_uniq String.compare request_ids in
    with_statement registry.db
      "SELECT id,source_id,request_ids,wait_for,command_id,state FROM \
       peer_subscriptions" (fun statement ->
        let rec collect subscription_ids =
          match Sqlite3.step statement with
          | Sqlite3.Rc.ROW ->
              let subscription = peer_subscription_of_statement statement in
              let references_deleted =
                List.exists
                  (fun request_id -> List.mem request_id request_ids)
                  subscription.request_ids
              in
              collect
                (if references_deleted then subscription.id :: subscription_ids
                 else subscription_ids)
          | Sqlite3.Rc.DONE -> subscription_ids
          | rc ->
              fail_rc "list subscriptions for deleted peer requests" rc;
              subscription_ids
        in
        collect [])
    |> List.iter (fun subscription_id ->
        with_statement registry.db "DELETE FROM peer_subscriptions WHERE id = ?"
          (fun statement ->
            bind_text statement 1 subscription_id;
            expect_done "delete subscription for deleted peer request" statement))

let delete_archived_ids registry ids =
  transaction registry (fun () ->
      List.fold_left
        (fun deleted id ->
          peer_request_ids_for_session registry id
          |> delete_subscriptions_referencing registry;
          with_statement registry.db
            "DELETE FROM peer_subscriptions WHERE source_id = ?"
            (fun statement ->
              bind_text statement 1 id;
              expect_done "delete archived peer subscriptions" statement);
          with_statement registry.db
            "DELETE FROM peer_requests WHERE source_id = ? OR target_id = ?"
            (fun statement ->
              bind_text statement 1 id;
              bind_text statement 2 id;
              expect_done "delete archived peer requests" statement);
          with_statement registry.db
            "DELETE FROM sessions WHERE id = ? AND archived_at IS NOT NULL"
            (fun statement ->
              bind_text statement 1 id;
              expect_done "delete archived session" statement);
          deleted + Sqlite3.changes registry.db)
        0 ids)

let delete_archived registry =
  list_archived registry
  |> List.map (fun (session : session) -> session.id)
  |> delete_archived_ids registry

let active_count registry = active_count_sql registry
let session_to_yojson = Registry_support.session_to_yojson
let workspace_to_yojson = Registry_support.workspace_to_yojson
