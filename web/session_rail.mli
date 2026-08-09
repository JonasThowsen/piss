open! Bonsai_web.Cont

type state =
  | Loading
  | Loaded of Control_plane.Session.t list
  | Failed of string

val selected : state -> string option -> Control_plane.Session.t option

val render :
  state ->
  workspaces:Workspace_catalog.workspace list ->
  selected_id:string option ->
  collapsed:Core.String.Set.t ->
  mobile_open:bool ->
  on_toggle:(string -> unit Effect.t) ->
  on_select:(string -> unit Effect.t) ->
  Vdom.Node.t
