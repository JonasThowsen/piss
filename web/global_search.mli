type scope = Active | Archived

type item = {
  session : Control_plane.Session.t;
  workspace : Workspace_catalog.workspace option;
}

val status_label :
  seen_finished_at:float Core.String.Map.t -> Control_plane.Session.t -> string

val items :
  scope:scope ->
  query:string ->
  seen_finished_at:float Core.String.Map.t ->
  workspaces:Workspace_catalog.workspace list ->
  active:Control_plane.Session.t list ->
  archived:Control_plane.Session.t list ->
  item list

val move : count:int -> current:int -> delta:int -> int

val move_clamped : count:int -> current:int -> delta:int -> int
(** Moves a session-search selection without wrapping at the first or last
    result. *)
