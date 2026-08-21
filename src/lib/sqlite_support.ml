let check operation rc =
  if not (Sqlite3.Rc.is_success rc) then
    failwith
      (Printf.sprintf "%s failed: %s" operation (Sqlite3.Rc.to_string rc))

let exec db sql = check sql (Sqlite3.exec db sql)

let configure_durable db =
  exec db "PRAGMA journal_mode=WAL";
  exec db "PRAGMA synchronous=FULL";
  exec db "PRAGMA foreign_keys=ON";
  exec db "PRAGMA busy_timeout=5000"

let has_column db ~table ~column =
  let statement = Sqlite3.prepare db ("PRAGMA table_info(" ^ table ^ ")") in
  Fun.protect
    ~finally:(fun () ->
      check "finalize schema inspection" (Sqlite3.finalize statement))
    (fun () ->
      let rec loop () =
        match Sqlite3.step statement with
        | Sqlite3.Rc.ROW ->
            String.equal (Sqlite3.column_text statement 1) column || loop ()
        | Sqlite3.Rc.DONE -> false
        | rc ->
            check "inspect table columns" rc;
            false
      in
      loop ())
