open! Bonsai_web.Cont

type output = {
  view : Vdom.Node.t;
  reset : unit -> unit Effect.t;
  set_notice : string -> unit Effect.t;
}

val component :
  Control_plane.Session.t option Bonsai.t ->
  string Bonsai.t ->
  Bonsai.graph ->
  output Bonsai.t
