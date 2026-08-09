open! Bonsai_web.Cont

val empty_state : string -> string -> string -> Vdom.Node.t

val render :
  copy_feedback:(string * Clipboard.status) option ->
  on_copy:(key:string -> text:string -> unit Effect.t) ->
  Event_history.entry ->
  Vdom.Node.t option
