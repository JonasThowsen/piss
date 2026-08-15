open! Bonsai_web.Cont

type state =
  | Loading
  | Loaded of Control_plane.Session.t list
  | Failed of string

val selected : state -> string option -> Control_plane.Session.t option

val render :
  state ->
  workspaces:Workspace_catalog.workspace list ->
  seen_finished_at:float Core.String.Map.t ->
  selected_id:string option ->
  collapsed:Core.String.Set.t ->
  menu_open:string option ->
  mobile_open:bool ->
  on_toggle:(string -> unit Effect.t) ->
  on_menu:(string option -> unit Effect.t) ->
  on_select:(string -> unit Effect.t) ->
  on_add_workspace:(unit -> unit Effect.t) ->
  on_remove_workspace:(Workspace_catalog.workspace -> unit Effect.t) ->
  on_create:(Workspace_catalog.workspace -> unit Effect.t) ->
  on_rename:(Control_plane.Session.t -> unit Effect.t) ->
  on_archive:(Control_plane.Session.t -> unit Effect.t) ->
  Vdom.Node.t
