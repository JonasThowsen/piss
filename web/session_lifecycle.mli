open! Bonsai_web.Cont

type output = {
  view : Vdom.Node.t;
  open_create : Workspace_catalog.workspace -> unit Effect.t;
  open_rename : Control_plane.Session.t -> unit Effect.t;
  open_archive : Control_plane.Session.t -> unit Effect.t;
}

val valid_title : string -> bool
val restore_and_wait : string -> (unit, string) result Async_kernel.Deferred.t

val component :
  harnesses:Control_plane.Session.harness list Bonsai.t ->
  on_reload:unit Effect.t Bonsai.t ->
  on_select:(string -> unit Effect.t) Bonsai.t ->
  Bonsai.graph ->
  output Bonsai.t
