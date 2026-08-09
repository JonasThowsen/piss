open! Bonsai_web.Cont

val component :
  Runtime_domain.t option Bonsai.t ->
  available:bool Bonsai.t ->
  refresh:unit Effect.t Bonsai.t ->
  on_error:(string -> unit Effect.t) Bonsai.t ->
  Bonsai.graph ->
  Vdom.Node.t Bonsai.t
