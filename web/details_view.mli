open! Bonsai_web.Cont

val render :
  session:Control_plane.Session.t ->
  workspace:Workspace_catalog.workspace option ->
  runtime:Runtime_domain.t option ->
  loading:bool ->
  error:string option ->
  Vdom.Node.t
