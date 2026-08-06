exception Registry_error of string

type session = {
  id : string;
  title : string;
  harness : string;
  created_at : float;
  archived_at : float option;
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

let expect_done operation statement =
  match Sqlite3.step statement with
  | Sqlite3.Rc.DONE -> ()
  | rc -> fail_rc operation rc

let initialize db =
  exec db "PRAGMA journal_mode=WAL";
  exec db "PRAGMA synchronous=FULL";
  exec db "PRAGMA busy_timeout=5000";
  exec db
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY,title TEXT NOT \
     NULL,harness TEXT NOT NULL CHECK(harness IN \
     ('pi','opencode','mock')),created_at REAL NOT NULL,archived_at REAL)";
  exec db
    "CREATE INDEX IF NOT EXISTS sessions_active_idx ON \
     sessions(archived_at,created_at)"

let open_ ~path =
  let db = Sqlite3.db_open path in
  initialize db;
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
  }

let insert registry ~id ~title ~harness =
  let created_at = Unix.gettimeofday () in
  with_statement registry.db
    "INSERT INTO sessions(id,title,harness,created_at,archived_at) VALUES \
     (?,?,?,?,NULL)" (fun statement ->
      bind_text statement 1 id;
      bind_text statement 2 title;
      bind_text statement 3 harness;
      bind_float statement 4 created_at;
      expect_done "create session" statement);
  { id; title; harness; created_at; archived_at = None }

let list registry ~include_archived =
  let sql =
    if include_archived then
      "SELECT id,title,harness,created_at,archived_at FROM sessions ORDER BY \
       created_at ASC"
    else
      "SELECT id,title,harness,created_at,archived_at FROM sessions WHERE \
       archived_at IS NULL ORDER BY created_at ASC"
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
    "SELECT id,title,harness,created_at,archived_at FROM sessions WHERE id = ?"
    (fun statement ->
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

let session_to_yojson session =
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
