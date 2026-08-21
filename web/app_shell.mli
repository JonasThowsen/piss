open! Bonsai_web.Cont

val render :
  header:Vdom.Node.t ->
  navigation_scrim:Vdom.Node.t ->
  session_rail:Vdom.Node.t ->
  workbench:Vdom.Node.t ->
  search_dialog:Vdom.Node.t ->
  session_lifecycle:Vdom.Node.t ->
  workspace_dialogs:Vdom.Node.t ->
  Vdom.Node.t
