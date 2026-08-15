open! Bonsai_web.Cont

type t = float Core.String.Map.t

val read : unit -> t
val write : t -> unit
val acknowledge : t -> Control_plane.Session.t -> t
val is_focused : unit -> bool
val start : on_focus:(unit -> unit) -> unit Effect.t
val cleanup : unit -> unit
