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
  prompt:string ->
  submitting:bool ->
  notice:string ->
  deciding_permissions:Core.String.Set.t ->
  on_prompt:(string -> unit Effect.t) ->
  on_submit:(unit -> unit Effect.t) ->
  on_permission:(request_id:string -> option_id:string option -> unit Effect.t) ->
  Vdom.Node.t
