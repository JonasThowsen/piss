open! Core
open! Bonsai_web.Cont

type state =
  | Loading
  | Loaded of Control_plane.Session.t list
  | Failed of string

let selected state selected_id =
  match (state, selected_id) with
  | Loaded sessions, Some id ->
      List.find sessions ~f:(fun (session : Control_plane.Session.t) ->
          String.equal session.id id)
  | _ -> None

let class_ name = Vdom.Attr.class_ name
let text = Vdom.Node.text

let render_session_row ~selected_id ~on_select
    (session : Control_plane.Session.t) =
  let status = Control_plane.Session.status_to_string session.status in
  let selected =
    Option.value_map selected_id ~default:false ~f:(String.equal session.id)
  in
  let row_class =
    "session-row" ^ if selected then " session-row-active" else ""
  in
  Vdom.Node.div ~key:session.id
    ~attrs:[ class_ "session-row-wrap" ]
    [
      Vdom.Node.button
        ~attrs:
          [
            class_ row_class;
            Vdom.Attr.create "type" "button";
            Vdom.Attr.create "aria-pressed" (Bool.to_string selected);
            Vdom.Attr.on_click (fun _ -> on_select session.id);
          ]
        [
          Vdom.Node.create "i"
            ~attrs:[ class_ ("session-dot status-" ^ status) ]
            [];
          Vdom.Node.span
            [
              Vdom.Node.strong [ text session.title ];
              Vdom.Node.small
                [
                  text
                    (status ^ " / "
                    ^ Control_plane.Session.harness_to_string session.harness);
                ];
            ];
        ];
    ]

let render_group ~selected_id ~collapsed ~on_toggle ~on_select
    (group : Workspace_catalog.group) =
  let workspace = group.workspace in
  let is_collapsed = Set.mem collapsed workspace.id in
  let panel_id = "workspace-sessions-" ^ workspace.id in
  Vdom.Node.section ~key:workspace.id
    ~attrs:[ class_ "workspace-group" ]
    [
      Vdom.Node.header
        ~attrs:[ class_ "workspace-heading" ]
        [
          Vdom.Node.button
            ~attrs:
              [
                class_ "workspace-toggle";
                Vdom.Attr.create "type" "button";
                Vdom.Attr.create "aria-expanded"
                  (Bool.to_string (not is_collapsed));
                Vdom.Attr.create "aria-controls" panel_id;
                Vdom.Attr.on_click (fun _ -> on_toggle workspace.id);
              ]
            [
              Vdom.Node.span
                ~attrs:
                  [
                    class_
                      ("workspace-chevron"
                      ^ if is_collapsed then " collapsed" else "");
                    Vdom.Attr.create "aria-hidden" "true";
                  ]
                [ text ">" ];
              Vdom.Node.span
                [
                  Vdom.Node.strong [ text workspace.name ];
                  Vdom.Node.small [ text workspace.root ];
                ];
            ];
        ];
      (if is_collapsed then Vdom.Node.none
       else
         Vdom.Node.div
           ~attrs:[ class_ "session-list"; Vdom.Attr.id panel_id ]
           (match group.sessions with
           | [] ->
               [
                 Vdom.Node.p
                   ~attrs:[ class_ "empty-workspace" ]
                   [ text "No active sessions" ];
               ]
           | sessions ->
               List.map sessions ~f:(render_session_row ~selected_id ~on_select)));
    ]

let render state ~workspaces ~selected_id ~collapsed ~mobile_open ~on_toggle
    ~on_select =
  let contents =
    match state with
    | Loading ->
        [
          Vdom.Node.p ~attrs:[ class_ "empty-workspace" ] [ text "Loading..." ];
        ]
    | Failed _ ->
        [
          Vdom.Node.p
            ~attrs:[ class_ "empty-workspace" ]
            [ text "Session list unavailable" ];
        ]
    | Loaded [] ->
        [
          Vdom.Node.p
            ~attrs:[ class_ "empty-workspace" ]
            [ text "No active sessions" ];
        ]
    | Loaded sessions ->
        Workspace_catalog.group workspaces sessions
        |> List.map
             ~f:(render_group ~selected_id ~collapsed ~on_toggle ~on_select)
  in
  Vdom.Node.create "aside"
    ~attrs:
      [
        Vdom.Attr.id "workspace-navigation";
        class_ ("runtime-rail" ^ if mobile_open then " mobile-open" else "");
        Vdom.Attr.create "aria-label" "Workspaces and sessions";
        Vdom.Attr.create "tabindex" "-1";
      ]
    [
      Vdom.Node.div
        ~attrs:[ class_ "rail-heading" ]
        [
          Vdom.Node.div
            [
              Vdom.Node.h2 [ text "Sessions" ];
              Vdom.Node.p [ text "Live control-plane state" ];
            ];
        ];
      Vdom.Node.create "nav" ~attrs:[ class_ "session-index" ] contents;
    ]
