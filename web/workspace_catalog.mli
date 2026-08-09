type workspace = {
  id : string;
  name : string;
  root : string;
  created_at : float;
}

type group = { workspace : workspace; sessions : Control_plane.Session.t list }
type directory = { name : string; path : string }

val decode : string -> (workspace list, string) result
val decode_directories : string -> (directory list, string) result
val group : workspace list -> Control_plane.Session.t list -> group list

val reconcile_selection :
  previous:string option -> Control_plane.Session.t list -> string option

val find_workspace : workspace list -> string -> workspace option
