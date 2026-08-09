open! Bonsai_web.Cont

val selected_workspace :
  Workspace_catalog.workspace list ->
  Control_plane.Session.t option ->
  Workspace_catalog.workspace option

val render :
  Session_rail.state ->
  Workspace_catalog.workspace list ->
  string option ->
  Runtime_domain.t option ->
  Vdom.Node.t ->
  Vdom.Node.t
