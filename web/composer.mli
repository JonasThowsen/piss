open! Bonsai_web.Cont

type output = {
  view : Vdom.Node.t;
  reset : unit -> unit Effect.t;
  set_notice : string -> unit Effect.t;
  has_pending : unit -> bool;
}

val component :
  Control_plane.Session.t option Bonsai.t ->
  Runtime_domain.t option Bonsai.t ->
  bool Bonsai.t ->
  string Bonsai.t ->
  Vdom.Node.t Bonsai.t ->
  on_busy:(bool -> unit Effect.t) Bonsai.t ->
  refresh_runtime:unit Effect.t Bonsai.t ->
  Bonsai.graph ->
  output Bonsai.t
