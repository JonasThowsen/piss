open! Bonsai_web.Cont

type output = {
  view : Vdom.Node.t;
  open_add : unit -> unit Effect.t;
  open_remove : Workspace_catalog.workspace -> unit Effect.t;
}

val component :
  on_reload:unit Effect.t Bonsai.t -> Bonsai.graph -> output Bonsai.t
