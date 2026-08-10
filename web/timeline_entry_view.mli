open! Bonsai_web.Cont

val empty_state : string -> string -> string -> Vdom.Node.t

val render_timeline :
  copy_feedback:(string * Clipboard.status) option ->
  on_copy:(key:string -> text:string -> unit Effect.t) ->
  Event_history.entry list ->
  Vdom.Node.t list
