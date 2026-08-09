open! Bonsai_web.Cont

val render :
  item_key:string ->
  copy_feedback:(string * Clipboard.status) option ->
  on_copy:(key:string -> text:string -> unit Effect.t) ->
  string ->
  Vdom.Node.t
