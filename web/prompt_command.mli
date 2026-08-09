type t

val prompt : command_id:string -> text:string -> (t, string) result
val command_id : t -> string
val to_yojson : t -> Yojson.Safe.t
