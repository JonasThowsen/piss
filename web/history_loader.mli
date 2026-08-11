open! Bonsai_web.Cont

val is_recovering : string -> bool

val load_initial :
  inject_history:(App_state.history_action -> unit Effect.t) ->
  inject_deciding:(App_state.deciding_action -> unit Effect.t) ->
  refresh_catalog_effect:unit Effect.t ->
  refresh_snapshot_effect:unit Effect.t ->
  set_stream_notice:(string -> unit Effect.t) ->
  string ->
  unit Effect.t

val load_older :
  inject_history:(App_state.history_action -> unit Effect.t) ->
  set_stream_notice:(string -> unit Effect.t) ->
  session_id:string ->
  before:int64 ->
  unit Effect.t
