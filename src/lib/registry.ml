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

let list registry ~include_archived =
  let sql =
    if include_archived then
      "SELECT \
       id,title,harness,created_at,archived_at,broker_token,workspace_id FROM \
       sessions ORDER BY created_at ASC"
    else
      "SELECT \
       id,title,harness,created_at,archived_at,broker_token,workspace_id FROM \
       sessions WHERE archived_at IS NULL ORDER BY created_at ASC"
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

let find registry id =
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

let find_active registry id =
  match find registry id with
  | Some ({ archived_at = None; _ } as session) -> Some session
  | _ -> None

let find_active_by_token registry token =
  with_statement registry.db
    "SELECT id,title,harness,created_at,archived_at,broker_token,workspace_id \
     FROM sessions WHERE broker_token = ? AND archived_at IS NULL"
    (fun statement ->
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
         peer_requests(id,source_id,target_id,prompt,command_id,start_sequence,state,response,created_at,updated_at) \
         VALUES (?,?,?,?,?,?,'accepted',NULL,?,?)" (fun statement ->
          bind_text statement 1 id;
          bind_text statement 2 source_id;
          bind_text statement 3 target_id;
          bind_text statement 4 prompt;
          bind_text statement 5 command_id;
          bind_int64 statement 6 start_sequence;
          bind_float statement 7 now;
          bind_float statement 8 now;
          expect_done "accept peer request" statement);
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
    "UPDATE peer_requests SET state = 'dispatching',start_sequence = \
     ?,updated_at = ? WHERE id = ? AND state IN ('accepted','queued')"
    (fun statement ->
      bind_int64 statement 1 start_sequence;
      bind_float statement 2 (Unix.gettimeofday ());
      bind_text statement 3 id;
      expect_done "mark peer request dispatching" statement)

let update_peer_request registry id ~state ~response =
  with_statement registry.db
    "UPDATE peer_requests SET state = ?,response = ?,updated_at = ? WHERE id = \
     ?" (fun statement ->
      bind_text statement 1 state;
      (match response with
      | Some value -> bind_text statement 2 value
      | None -> fail_rc "bind null" (Sqlite3.bind statement 2 Sqlite3.Data.NULL));
      bind_float statement 3 (Unix.gettimeofday ());
      bind_text statement 4 id;
      expect_done "update peer request" statement)

let complete_peer_request registry id response =
  with_statement registry.db
    "UPDATE peer_requests SET state = 'completed',response = ?,updated_at = ? \
     WHERE id = ? AND state <> 'completed'" (fun statement ->
      bind_text statement 1 response;
      bind_float statement 2 (Unix.gettimeofday ());
      bind_text statement 3 id;
      expect_done "complete peer request" statement);
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
    "UPDATE sessions SET archived_at = ? WHERE id = ? AND archived_at IS NULL"
    (fun statement ->
      bind_float statement 1 (Unix.gettimeofday ());
      bind_text statement 2 id;
      expect_done "archive session" statement);
  Sqlite3.changes registry.db > 0

let restore registry id =
  with_statement registry.db
    "UPDATE sessions SET archived_at = NULL WHERE id = ? AND archived_at IS \
     NOT NULL" (fun statement ->
      bind_text statement 1 id;
      expect_done "restore session" statement);
  Sqlite3.changes registry.db > 0

let list_archived registry =
  list registry ~include_archived:true
  |> List.filter (fun session -> Option.is_some session.archived_at)

let delete_archived registry =
  transaction registry (fun () ->
      with_statement registry.db
        "DELETE FROM peer_subscriptions WHERE source_id IN (SELECT id FROM \
         sessions WHERE archived_at IS NOT NULL)" (fun statement ->
          expect_done "delete archived peer subscriptions" statement);
      with_statement registry.db
        "DELETE FROM peer_requests WHERE source_id IN (SELECT id FROM sessions \
         WHERE archived_at IS NOT NULL) OR target_id IN (SELECT id FROM \
         sessions WHERE archived_at IS NOT NULL)" (fun statement ->
          expect_done "delete archived peer requests" statement);
      with_statement registry.db
        "DELETE FROM sessions WHERE archived_at IS NOT NULL" (fun statement ->
          expect_done "delete archived sessions" statement);
      Sqlite3.changes registry.db)

let active_count registry = List.length (list registry ~include_archived:false)
let session_to_yojson = Registry_support.session_to_yojson
let workspace_to_yojson = Registry_support.workspace_to_yojson
