open! Bonsai_web.Cont

val start : on_escape:(unit -> unit Effect.t) -> unit Effect.t
val cleanup : unit -> unit Effect.t
val focus_navigation : unit -> unit Effect.t
val focus_menu_button : unit -> unit Effect.t
val menu_button : open_:bool -> on_open:(unit -> unit Effect.t) -> Vdom.Node.t
val scrim : open_:bool -> on_close:(unit -> unit Effect.t) -> Vdom.Node.t
