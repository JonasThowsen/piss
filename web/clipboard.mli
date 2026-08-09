open! Bonsai_web.Cont

type status = Copied | Failed

val copy :
  key:string ->
  text:string ->
  on_change:((string * status) option -> unit Effect.t) ->
  unit Effect.t

val cleanup : unit -> unit Effect.t
