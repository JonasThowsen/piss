type t
type resource = { path : string }
type image = { mime_type : string; data : string; name : string }
type action = Prompt | Steer | Follow_up

val action_to_string : action -> string
val action_of_string : string -> (action, string) result

val create :
  action:action ->
  images:image list ->
  resources:resource list ->
  command_id:string ->
  text:string ->
  (t, string) result

val prompt :
  images:image list ->
  resources:resource list ->
  command_id:string ->
  text:string ->
  (t, string) result

val command_id : t -> string
val action : t -> action
val to_yojson : t -> Yojson.Safe.t
