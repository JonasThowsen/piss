type t
type resource = { path : string }

val prompt :
  resources:resource list ->
  command_id:string ->
  text:string ->
  (t, string) result

val command_id : t -> string
val to_yojson : t -> Yojson.Safe.t
