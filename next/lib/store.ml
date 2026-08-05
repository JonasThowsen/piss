open Domain

exception Store_error of string

type t = { db : Sqlite3.db; session_id : session_id; worker_id : worker_id }
type accepted_command = { state : command_state; duplicate : bool }

let max_retained_events = 4096
let max_retained_commands = 1024

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
     KEY,request_id TEXT NOT NULL UNIQUE,prompt TEXT NOT NULL,state TEXT NOT \
     NULL,created_at REAL NOT NULL,updated_at REAL NOT NULL)";
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

let row_count store table =
  scalar_int64 store ~operation:("count " ^ table)
    ("SELECT COUNT(*) FROM " ^ table)

let append_event store ~kind payload =
  if row_count store "events" >= Int64.of_int max_retained_events then
    raise
      (Store_error
         (Printf.sprintf "event retention limit reached (%d)"
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

let accept_command store ~command_id ~request_id ~prompt =
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
            "INSERT INTO commands(command_id, request_id, prompt, state, \
             created_at, updated_at) VALUES (?, ?, ?, 'accepted', ?, ?)"
            (fun statement ->
              bind_text statement 1 command_id;
              bind_text statement 2 request_id;
              bind_text statement 3 prompt;
              bind_float statement 4 now;
              bind_float statement 5 now;
              expect_done "accept command" statement);
          ignore
            (append_event store ~kind:"command.accepted"
               (`Assoc
                  [
                    ("commandId", `String command_id);
                    ("requestId", `String request_id);
                  ]));
          { state = Accepted; duplicate = false })

let set_command_state store ~command_id state =
  transaction store (fun () ->
      with_statement store.db
        "UPDATE commands SET state = ?, updated_at = ? WHERE command_id = ?"
        (fun statement ->
          bind_text statement 1 (command_state_to_string state);
          bind_float statement 2 (Unix.gettimeofday ());
          bind_text statement 3 command_id;
          expect_done "update command" statement);
      ignore
        (append_event store ~kind:"command.state"
           (`Assoc
              [
                ("commandId", `String command_id);
                ("state", `String (command_state_to_string state));
              ])))
