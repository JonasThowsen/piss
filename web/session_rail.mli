open! Bonsai_web.Cont

type state =
  | Loading
  | Loaded of Control_plane.Session.t list
  | Failed of string

val render :
  state ->
  selected_id:string option ->
  on_select:(string -> unit Effect.t) ->
  Vdom.Node.t
