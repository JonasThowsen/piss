exception Registry_error of string

type session = {
  id : string;
  title : string;
  harness : string;
  created_at : float;
  archived_at : float option;
  broker_token : string;
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
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY,title TEXT NOT \
     NULL,harness TEXT NOT NULL CHECK(harness IN \
     ('pi','opencode','mock')),created_at REAL NOT NULL,archived_at \
     REAL,broker_token TEXT NOT NULL DEFAULT '')";
  if not (has_column db "sessions" "broker_token") then
    exec db
      "ALTER TABLE sessions ADD COLUMN broker_token TEXT NOT NULL DEFAULT ''";
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
     NULL,response TEXT,created_at REAL NOT NULL,updated_at REAL NOT \
     NULL,FOREIGN KEY(source_id) REFERENCES sessions(id),FOREIGN \
     KEY(target_id) REFERENCES sessions(id))"

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
  }

let insert registry ~id ~title ~harness =
  let created_at = Unix.gettimeofday () in
  let broker_token = random_secret () in
  with_statement registry.db
    "INSERT INTO \
     sessions(id,title,harness,created_at,archived_at,broker_token) VALUES \
     (?,?,?,?,NULL,?)" (fun statement ->
      bind_text statement 1 id;
      bind_text statement 2 title;
      bind_text statement 3 harness;
      bind_float statement 4 created_at;
      bind_text statement 5 broker_token;
      expect_done "create session" statement);
  { id; title; harness; created_at; archived_at = None; broker_token }

let list registry ~include_archived =
  let sql =
    if include_archived then
      "SELECT id,title,harness,created_at,archived_at,broker_token FROM \
       sessions ORDER BY created_at ASC"
    else
      "SELECT id,title,harness,created_at,archived_at,broker_token FROM \
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
    "SELECT id,title,harness,created_at,archived_at,broker_token FROM sessions \
     WHERE id = ?" (fun statement ->
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
    "SELECT id,title,harness,created_at,archived_at,broker_token FROM sessions \
     WHERE broker_token = ? AND archived_at IS NULL" (fun statement ->
      bind_text statement 1 token;
      match Sqlite3.step statement with
      | Sqlite3.Rc.ROW -> Some (session_of_statement statement)
      | Sqlite3.Rc.DONE -> None
      | rc ->
          fail_rc "find broker session" rc;
          None)

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

let active_count registry = List.length (list registry ~include_archived:false)

let session_to_yojson (session : session) =
  `Assoc
    [
      ("id", `String session.id);
      ("title", `String session.title);
      ("harness", `String session.harness);
      ("createdAt", `Float session.created_at);
      ( "archivedAt",
        match session.archived_at with
        | Some value -> `Float value
        | None -> `Null );
    ]
