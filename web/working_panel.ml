open! Core
open! Bonsai_web.Cont

let class_ name = Vdom.Attr.class_ name
let text = Vdom.Node.text

let tool_card (tool : Working_view.tool) =
  Vdom.Node.create "article"
    ~attrs:[ class_ "timeline-item timeline-tool" ]
    [
      Vdom.Node.create "details"
        ~attrs:[ class_ "tool-disclosure"; Vdom.Attr.create "open" "" ]
        [
          Vdom.Node.create "summary"
            [
              Vdom.Node.span
                ~attrs:[ class_ "tool-disclosure-icon" ]
                [ text ">" ];
              Vdom.Node.strong
                ~attrs:[ class_ "message-role" ]
                [ text tool.title ];
              Vdom.Node.span
                ~attrs:[ class_ "message-status" ]
                [ text tool.status ];
            ];
          Vdom.Node.div
            ~attrs:[ class_ "timeline-contents" ]
            [
              Vdom.Node.p ~attrs:[ class_ "message-body" ] [ text tool.detail ];
            ];
        ];
    ]

let render model ~hidden =
  let phase = Working_view.phase_label model.Working_view.phase in
  let phase_class =
    match model.phase with
    | Running_tool -> "running"
    | Thinking -> "thinking"
    | Awaiting_permission -> "awaiting"
    | Connecting -> "connecting"
    | Idle -> "idle"
  in
  Vdom.Node.div
    ~attrs:
      ([
         Vdom.Attr.id "session-panel-working";
         class_ ("working-view working-view-" ^ phase_class);
         Vdom.Attr.create "role" "tabpanel";
         Vdom.Attr.create "aria-labelledby" "session-tab-working";
       ]
      @ if hidden then [ Vdom.Attr.create "hidden" "" ] else [])
    [
      Vdom.Node.header
        ~attrs:[ class_ "working-header" ]
        [
          Vdom.Node.div
            ~attrs:[ class_ "working-status" ]
            [
              Vdom.Node.span
                ~attrs:[ class_ ("working-pulse working-pulse-" ^ phase_class) ]
                [
                  Vdom.Node.create "i" ~attrs:[ class_ "working-pulse-dot" ] [];
                ];
              Vdom.Node.span
                ~attrs:[ class_ "working-status-label" ]
                [ text phase ];
            ];
          Vdom.Node.h2
            ~attrs:[ class_ "working-detail" ]
            [ text (Working_view.phase_detail model) ];
          Vdom.Node.p
            ~attrs:[ class_ "working-note" ]
            [ text "A focused projection of live agent and tool activity." ];
        ];
      Vdom.Node.section
        ~attrs:[ class_ "working-current-card" ]
        [
          Option.value_map model.current
            ~default:
              (Vdom.Node.div
                 ~attrs:[ class_ "working-current-card-empty" ]
                 [
                   Vdom.Node.p
                     ~attrs:[ class_ "working-current-empty-message" ]
                     [ text (Working_view.phase_detail model) ];
                 ])
            ~f:tool_card;
        ];
      Vdom.Node.section
        ~attrs:[ class_ "working-recent" ]
        [
          Vdom.Node.h3 [ text "Recent tools" ];
          (match model.recent with
          | [] ->
              Vdom.Node.p
                ~attrs:[ class_ "working-note" ]
                [ text "No recent tools." ]
          | tools ->
              Vdom.Node.create "ul"
                ~attrs:[ class_ "working-recent-list" ]
                (List.map tools ~f:(fun tool ->
                     Vdom.Node.create "li"
                       ~key:(Int64.to_string tool.sequence)
                       ~attrs:
                         [
                           class_
                             ("working-recent-row working-recent-row-"
                            ^ tool.status);
                         ]
                       [
                         Vdom.Node.span
                           ~attrs:[ class_ "message-status" ]
                           [ text (Int64.to_string tool.sequence) ];
                         Vdom.Node.strong
                           ~attrs:[ class_ "working-recent-title" ]
                           [ text tool.title ];
                         Vdom.Node.span
                           ~attrs:[ class_ "message-status" ]
                           [ text tool.status ];
                       ])));
        ];
    ]
