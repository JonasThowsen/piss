open! Bonsai_web.Cont

type state =
  | Sessions_loading
  | Sessions_failed of string
  | No_sessions
  | Awaiting_selection
  | Loading of string
  | Loaded of string * Event_buffer.t
  | Failed of string * string

val render :
  session:Control_plane.Session.t option ->
  state:state ->
  composer:Vdom.Node.t option ->
  deciding_permissions:Core.String.Set.t ->
  copy_feedback:(string * Clipboard.status) option ->
  on_copy:(key:string -> text:string -> unit Effect.t) ->
  on_permission:(request_id:string -> option_id:string option -> unit Effect.t) ->
  Vdom.Node.t
