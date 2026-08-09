type scope = Active | Archived

type item = {
  session : Control_plane.Session.t;
  workspace : Workspace_catalog.workspace option;
}

val items :
  scope:scope ->
  query:string ->
  workspaces:Workspace_catalog.workspace list ->
  active:Control_plane.Session.t list ->
  archived:Control_plane.Session.t list ->
  item list

val available_harnesses :
  active:Control_plane.Session.t list ->
  archived:Control_plane.Session.t list ->
  Control_plane.Session.harness list

val move : count:int -> current:int -> delta:int -> int
