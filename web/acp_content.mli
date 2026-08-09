val tool_content :
  path:string -> Yojson.Safe.t -> (string * string list, string) result

val locations :
  path:string -> (string * Yojson.Safe.t) list -> (string list, string) result
