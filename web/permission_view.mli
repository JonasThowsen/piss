open! Core
open! Bonsai_web.Cont

val render_pending_requests :
  Event_history.pending_permission list ->
  deciding:String.Set.t ->
  on_decide:(request_id:string -> option_id:string option -> unit Effect.t) ->
  Vdom.Node.t list

val render_pending :
  Event_history.entry list ->
  deciding:String.Set.t ->
  on_decide:(request_id:string -> option_id:string option -> unit Effect.t) ->
  Vdom.Node.t list
