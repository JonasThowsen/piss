open! Core
open! Bonsai_web.Cont

type state =
  | Loading
  | Loaded of Control_plane.Session.t list
  | Failed of string

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

let render state ~selected_id ~on_select =
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
        List.map sessions ~f:(render_session_row ~selected_id ~on_select)
  in
  Vdom.Node.create "aside"
    ~attrs:[ class_ "runtime-rail" ]
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
      Vdom.Node.create "nav"
        ~attrs:[ class_ "session-index" ]
        [
          Vdom.Node.section
            ~attrs:[ class_ "workspace-group" ]
            [ Vdom.Node.div ~attrs:[ class_ "session-list" ] contents ];
        ];
    ]
