open! Bonsai_web.Cont

type output = {
  trigger : Vdom.Node.t;
  view : Vdom.Node.t;
  close : unit Effect.t;
}

val component :
  workspaces:Workspace_catalog.workspace list Bonsai.t ->
  active:Control_plane.Session.t list Bonsai.t ->
  archived:Control_plane.Session.t list Bonsai.t ->
  on_open:unit Effect.t Bonsai.t ->
  on_reload:unit Effect.t Bonsai.t ->
  on_select:(string -> unit Effect.t) Bonsai.t ->
  Bonsai.graph ->
  output Bonsai.t

val cleanup : unit -> unit Effect.t
