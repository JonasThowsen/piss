open! Core
open! Bonsai_web.Cont

let class_ name = [ Vdom.Attr.class_ name ]
let text = Vdom.Node.text

let selected_workspace workspaces session =
  Option.bind session ~f:(fun (session : Control_plane.Session.t) ->
      Workspace_catalog.find_workspace workspaces session.workspace_id)

let render sessions workspaces selected_id (runtime : Runtime_domain.t option)
    mobile_menu search notifications =
  let selected = Session_rail.selected sessions selected_id in
  let workspace = selected_workspace workspaces selected in
  let status, status_class =
    match (sessions, selected, runtime) with
    | Session_rail.Loading, _, _ -> ("loading", "running")
    | Session_rail.Failed _, _, _ -> ("offline", "offline")
    | Session_rail.Loaded [], _, _ -> ("idle", "idle")
    | Session_rail.Loaded _, Some _, Some runtime ->
        let status_class = Runtime_domain.status_to_string runtime.status in
        (Runtime_domain.status_label runtime.status, status_class)
    | Session_rail.Loaded _, Some session, None ->
        let status_class =
          Control_plane.Session.status_to_string session.status
        in
        (Runtime_domain.status_label session.status, status_class)
    | Session_rail.Loaded _, None, _ -> ("idle", "idle")
  in
  let title =
    Option.value_map selected ~default:"Piss" ~f:(fun session -> session.title)
  in
  let context =
    Option.value_map workspace ~default:"Durable agent workbench"
      ~f:(fun workspace -> workspace.name ^ " / " ^ workspace.root)
  in
  Vdom.Node.header ~attrs:(class_ "app-header")
    [
      mobile_menu;
      Vdom.Node.div ~attrs:(class_ "brand-lockup")
        [
          Vdom.Node.span ~attrs:(class_ "brand-mark") [ text "P" ];
          Vdom.Node.div
            [
              Vdom.Node.h1 [ text title ];
              Vdom.Node.p ~attrs:(class_ "eyebrow") [ text context ];
            ];
        ];
      search;
      notifications;
      Vdom.Node.div
        ~attrs:(class_ ("connection-pill connection-" ^ status_class))
        [ Vdom.Node.create "i" []; Vdom.Node.span [ text status ] ];
    ]
