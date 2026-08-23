open! Bonsai_web.Cont

val component : Bonsai.graph -> Vdom.Node.t Bonsai.t
val observe_sessions : Control_plane.Session.t list -> unit
val requested_session : unit -> string option
val clear_requested_session : unit -> unit
