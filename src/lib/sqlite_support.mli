(** Shared SQLite connection policy owned by [piss.persistence]. Schema and
    migrations remain owned by the store that calls this module. *)

val configure_durable : Sqlite3.db -> unit
(** Enable WAL, FULL synchronous durability, foreign keys, and a five-second
    busy timeout. Raises [Failure] if SQLite rejects a pragma. *)

val has_column : Sqlite3.db -> table:string -> column:string -> bool
(** Inspect a table without mutating its schema. Raises [Failure] on an SQLite
    error. *)
