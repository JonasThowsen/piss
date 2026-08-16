exception Registry_error of string

type workspace = {
  id : string;
  name : string;
  root : string;
  created_at : float;
}

type session = {
  id : string;
  title : string;
  harness : string;
  created_at : float;
  archived_at : float option;
  broker_token : string;
  workspace_id : string;
}

type peer_request = {
  id : string;
  source_id : string;
  target_id : string;
  prompt : string;
  command_id : string;
  start_sequence : int64;
  state : string;
  response : string option;
}

type peer_subscription = {
  id : string;
  source_id : string;
  request_ids : string list;
  wait_for : string;
  command_id : string;
  state : string;
}

type t = { db : Sqlite3.db }

let fail_rc operation rc =
  if not (Sqlite3.Rc.is_success rc) then
    raise
      (Registry_error
         (Printf.sprintf "%s failed: %s" operation (Sqlite3.Rc.to_string rc)))

let exec db sql = fail_rc sql (Sqlite3.exec db sql)

let with_statement db sql f =
  let statement = Sqlite3.prepare db sql in
  Fun.protect
    ~finally:(fun () -> fail_rc "finalize" (Sqlite3.finalize statement))
    (fun () -> f statement)

let bind_text statement position value =
  fail_rc "bind text" (Sqlite3.bind_text statement position value)

let bind_float statement position value =
  fail_rc "bind float" (Sqlite3.bind_double statement position value)

let bind_int64 statement position value =
  fail_rc "bind int64" (Sqlite3.bind_int64 statement position value)

let expect_done operation statement =
  match Sqlite3.step statement with
  | Sqlite3.Rc.DONE -> ()
  | rc -> fail_rc operation rc

let random_secret () =
  let channel = open_in_bin "/dev/urandom" in
  let bytes =
    Fun.protect
      ~finally:(fun () -> close_in_noerr channel)
      (fun () -> really_input_string channel 32)
  in
  let buffer = Buffer.create 64 in
  String.iter
    (fun byte ->
      Buffer.add_string buffer (Printf.sprintf "%02x" (Char.code byte)))
    bytes;
  Buffer.contents buffer

let has_column db table column =
  with_statement db
    ("PRAGMA table_info(" ^ table ^ ")")
    (fun statement ->
      let rec loop () =
        match Sqlite3.step statement with
        | Sqlite3.Rc.ROW ->
            if String.equal (Sqlite3.column_text statement 1) column then true
            else loop ()
        | Sqlite3.Rc.DONE -> false
        | rc ->
            fail_rc "inspect table" rc;
            false
      in
      loop ())

let initialize db =
  exec db "PRAGMA journal_mode=WAL";
  exec db "PRAGMA synchronous=FULL";
  exec db "PRAGMA foreign_keys=ON";
  exec db "PRAGMA busy_timeout=5000";
  exec db
    "CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY,name TEXT NOT \
     NULL,root TEXT NOT NULL UNIQUE,created_at REAL NOT NULL)";
  exec db
    "CREATE TABLE IF NOT EXISTS workspace_removals (id TEXT PRIMARY KEY, \
     removed_at REAL NOT NULL)";
  exec db
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY,title TEXT NOT \
     NULL,harness TEXT NOT NULL CHECK(harness IN \
     ('pi','opencode','mock')),created_at REAL NOT NULL,archived_at \
     REAL,broker_token TEXT NOT NULL DEFAULT '',workspace_id TEXT NOT NULL \
     DEFAULT '')";
  if not (has_column db "sessions" "broker_token") then
    exec db
      "ALTER TABLE sessions ADD COLUMN broker_token TEXT NOT NULL DEFAULT ''";
  if not (has_column db "sessions" "workspace_id") then
    exec db
      "ALTER TABLE sessions ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''";
  exec db
    "CREATE INDEX IF NOT EXISTS sessions_active_idx ON \
     sessions(archived_at,created_at)";
  exec db
    "CREATE UNIQUE INDEX IF NOT EXISTS sessions_broker_token_idx ON \
     sessions(broker_token) WHERE broker_token <> ''";
  exec db
    "CREATE TABLE IF NOT EXISTS peer_requests (id TEXT PRIMARY KEY,source_id \
     TEXT NOT NULL,target_id TEXT NOT NULL,prompt TEXT NOT NULL,command_id \
     TEXT NOT NULL UNIQUE,start_sequence INTEGER NOT NULL,state TEXT NOT \
     NULL,response TEXT,managed_reconciliation INTEGER NOT NULL DEFAULT \
     0,created_at REAL NOT NULL,updated_at REAL NOT NULL,FOREIGN \
     KEY(source_id) REFERENCES sessions(id),FOREIGN KEY(target_id) REFERENCES \
     sessions(id))";
  if not (has_column db "peer_requests" "managed_reconciliation") then
    exec db
      "ALTER TABLE peer_requests ADD COLUMN managed_reconciliation INTEGER NOT \
       NULL DEFAULT 0";
  exec db
    "CREATE TABLE IF NOT EXISTS peer_subscriptions (id TEXT PRIMARY \
     KEY,source_id TEXT NOT NULL,request_ids TEXT NOT NULL,wait_for TEXT NOT \
     NULL CHECK(wait_for IN ('any','all')),command_id TEXT NOT NULL \
     UNIQUE,state TEXT NOT NULL CHECK(state IN \
     ('pending','dispatching','delivered')),created_at REAL NOT \
     NULL,updated_at REAL NOT NULL,FOREIGN KEY(source_id) REFERENCES \
     sessions(id))";
  exec db
    "CREATE INDEX IF NOT EXISTS peer_requests_source_state_idx ON \
     peer_requests(source_id,state)";
  exec db
    "CREATE INDEX IF NOT EXISTS peer_requests_reconcile_idx ON \
     peer_requests(managed_reconciliation,state,updated_at)";
  exec db
    "CREATE INDEX IF NOT EXISTS peer_subscriptions_open_idx ON \
     peer_subscriptions(state,created_at)";
  exec db
    "CREATE INDEX IF NOT EXISTS peer_subscriptions_source_state_idx ON \
     peer_subscriptions(source_id,state)"

let session_of_statement statement =
  {
    id = Sqlite3.column_text statement 0;
    title = Sqlite3.column_text statement 1;
    harness = Sqlite3.column_text statement 2;
    created_at = Sqlite3.column_double statement 3;
    archived_at =
      (match Sqlite3.column statement 4 with
      | Sqlite3.Data.NULL -> None
      | _ -> Some (Sqlite3.column_double statement 4));
    broker_token = Sqlite3.column_text statement 5;
    workspace_id = Sqlite3.column_text statement 6;
  }

let workspace_of_statement statement =
  {
    id = Sqlite3.column_text statement 0;
    name = Sqlite3.column_text statement 1;
    root = Sqlite3.column_text statement 2;
    created_at = Sqlite3.column_double statement 3;
  }

let peer_request_of_statement statement =
  {
    id = Sqlite3.column_text statement 0;
    source_id = Sqlite3.column_text statement 1;
    target_id = Sqlite3.column_text statement 2;
    prompt = Sqlite3.column_text statement 3;
    command_id = Sqlite3.column_text statement 4;
    start_sequence = Sqlite3.column_int64 statement 5;
    state = Sqlite3.column_text statement 6;
    response =
      (match Sqlite3.column statement 7 with
      | Sqlite3.Data.NULL -> None
      | _ -> Some (Sqlite3.column_text statement 7));
  }

let peer_subscription_of_statement statement =
  let request_ids =
    Sqlite3.column_text statement 2
    |> Yojson.Safe.from_string |> Yojson.Safe.Util.to_list
    |> List.map Yojson.Safe.Util.to_string
  in
  {
    id = Sqlite3.column_text statement 0;
    source_id = Sqlite3.column_text statement 1;
    request_ids;
    wait_for = Sqlite3.column_text statement 3;
    command_id = Sqlite3.column_text statement 4;
    state = Sqlite3.column_text statement 5;
  }

let session_to_yojson (session : session) =
  `Assoc
    [
      ("id", `String session.id);
      ("title", `String session.title);
      ("harness", `String session.harness);
      ("workspaceId", `String session.workspace_id);
      ("createdAt", `Float session.created_at);
      ( "archivedAt",
        match session.archived_at with
        | Some value -> `Float value
        | None -> `Null );
    ]

let workspace_to_yojson (workspace : workspace) =
  `Assoc
    [
      ("id", `String workspace.id);
      ("name", `String workspace.name);
      ("root", `String workspace.root);
      ("createdAt", `Float workspace.created_at);
    ]
