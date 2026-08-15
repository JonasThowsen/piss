type scope = Active | Archived

type item = {
  session : Control_plane.Session.t;
  workspace : Workspace_catalog.workspace option;
}

val status_label : Control_plane.Session.t -> string

val items :
  scope:scope ->
  query:string ->
  workspaces:Workspace_catalog.workspace list ->
  active:Control_plane.Session.t list ->
  archived:Control_plane.Session.t list ->
  item list

val move : count:int -> current:int -> delta:int -> int
