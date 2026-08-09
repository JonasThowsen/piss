open! Core
open! Bonsai_web.Cont

type load_state =
  | Loading
  | Loaded of Control_plane.Session.t list
  | Failed of string

let class_ name = [ Vdom.Attr.class_ name ]
let text = Vdom.Node.text

let render_header state =
  let status, status_class =
    match state with
    | Loading -> ("loading", "running")
    | Failed _ -> ("offline", "offline")
    | Loaded [] -> ("idle", "idle")
    | Loaded (session :: _) ->
        let status = Control_plane.Session.status_to_string session.status in
        (status, status)
  in
  Vdom.Node.header ~attrs:(class_ "app-header")
    [
      Vdom.Node.div ~attrs:(class_ "brand-lockup")
        [
          Vdom.Node.span ~attrs:(class_ "brand-mark") [ text "P" ];
          Vdom.Node.div
            [
              Vdom.Node.h1 [ text "PISS" ];
              Vdom.Node.p ~attrs:(class_ "eyebrow")
                [ text "Durable agent workbench" ];
            ];
        ];
      Vdom.Node.div
        ~attrs:(class_ ("connection-pill connection-" ^ status_class))
        [ Vdom.Node.create "i" []; Vdom.Node.span [ text status ] ];
    ]

let render_session_row (session : Control_plane.Session.t) =
  let status = Control_plane.Session.status_to_string session.status in
  Vdom.Node.div ~key:session.id
    ~attrs:(class_ "session-row-wrap")
    [
      Vdom.Node.div ~attrs:(class_ "session-row")
        [
          Vdom.Node.create "i"
            ~attrs:(class_ ("session-dot status-" ^ status))
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

let render_rail state =
  let contents =
    match state with
    | Loading ->
        [ Vdom.Node.p ~attrs:(class_ "empty-workspace") [ text "Loading..." ] ]
    | Failed _ ->
        [
          Vdom.Node.p ~attrs:(class_ "empty-workspace")
            [ text "Session list unavailable" ];
        ]
    | Loaded [] ->
        [
          Vdom.Node.p ~attrs:(class_ "empty-workspace")
            [ text "No active sessions" ];
        ]
    | Loaded sessions -> List.map sessions ~f:render_session_row
  in
  Vdom.Node.create "aside" ~attrs:(class_ "runtime-rail")
    [
      Vdom.Node.div ~attrs:(class_ "rail-heading")
        [
          Vdom.Node.div
            [
              Vdom.Node.h2 [ text "Sessions" ];
              Vdom.Node.p [ text "Live control-plane state" ];
            ];
        ];
      Vdom.Node.create "nav" ~attrs:(class_ "session-index")
        [
          Vdom.Node.section ~attrs:(class_ "workspace-group")
            [ Vdom.Node.div ~attrs:(class_ "session-list") contents ];
        ];
    ]

let detail_row label value =
  Vdom.Node.div [ Vdom.Node.dt [ text label ]; Vdom.Node.dd [ text value ] ]

let render_loaded (sessions : Control_plane.Session.t list) =
  match sessions with
  | [] ->
      Vdom.Node.div ~attrs:(class_ "timeline")
        [
          Vdom.Node.div ~attrs:(class_ "timeline-stream")
            [
              Vdom.Node.div ~attrs:(class_ "empty-state")
                [
                  Vdom.Node.span [ text "0" ];
                  Vdom.Node.h3 [ text "No active sessions." ];
                  Vdom.Node.p
                    [
                      text
                        "The control plane returned an empty active-session \
                         list.";
                    ];
                ];
            ];
        ]
  | session :: _ ->
      let count = List.length sessions in
      Vdom.Node.div ~attrs:(class_ "session-details")
        [
          Vdom.Node.header
            [
              Vdom.Node.span [ text "FIRST ACTIVE SESSION" ];
              Vdom.Node.h2 [ text session.title ];
              Vdom.Node.p
                [
                  text
                    (Printf.sprintf "The backend returned %d active session%s."
                       count
                       (if count = 1 then "" else "s"));
                ];
            ];
          Vdom.Node.dl
            [
              detail_row "Status"
                (Control_plane.Session.status_to_string session.status);
              detail_row "Harness"
                (Control_plane.Session.harness_to_string session.harness);
              detail_row "Workspace" session.workspace_id;
              detail_row "Session ID" session.id;
            ];
        ]

let render_state state =
  let title, content =
    match state with
    | Loading ->
        ( "Loading sessions",
          Vdom.Node.div ~attrs:(class_ "timeline")
            [
              Vdom.Node.div ~attrs:(class_ "timeline-stream")
                [
                  Vdom.Node.div ~attrs:(class_ "empty-state")
                    [
                      Vdom.Node.span [ text "..." ];
                      Vdom.Node.h3 [ text "Loading active sessions..." ];
                      Vdom.Node.p
                        [
                          text
                            "Waiting for the same-origin control-plane \
                             response.";
                        ];
                    ];
                ];
            ] )
    | Failed message ->
        ( "Session load failed",
          Vdom.Node.div ~attrs:(class_ "timeline")
            [
              Vdom.Node.div ~attrs:(class_ "timeline-stream")
                [
                  Vdom.Node.div ~attrs:(class_ "empty-state")
                    [
                      Vdom.Node.span [ text "!" ];
                      Vdom.Node.h3 [ text "Could not load sessions." ];
                      Vdom.Node.p [ text message ];
                    ];
                ];
            ] )
    | Loaded sessions -> ("Active sessions", render_loaded sessions)
  in
  Vdom.Node.main ~attrs:(class_ "control-room")
    [
      render_header state;
      Vdom.Node.section ~attrs:(class_ "workspace-grid")
        [
          render_rail state;
          Vdom.Node.section
            ~attrs:(class_ "conversation-panel")
            [
              Vdom.Node.header
                ~attrs:(class_ "conversation-heading")
                [
                  Vdom.Node.h2 [ text title ];
                  Vdom.Node.span ~attrs:(class_ "sequence-label")
                    [ text "GET /api/v2/sessions" ];
                ];
              Vdom.Node.div ~attrs:(class_ "timeline-wrap") [ content ];
            ];
        ];
    ]

let component graph =
  let state, set_state = Bonsai.state Loading graph in
  let load =
    Bonsai.map set_state ~f:(fun set_state ->
        Effect.bind
          (Effect.of_deferred_thunk (fun () ->
               Browser_http.get "/api/v2/sessions"))
          ~f:(function
            | Error error -> set_state (Failed (Error.to_string_hum error))
            | Ok body -> (
                match Control_plane.decode_sessions body with
                | Ok sessions -> set_state (Loaded sessions)
                | Error message -> set_state (Failed message))))
  in
  Bonsai.Edge.lifecycle ~on_activate:load graph;
  Bonsai.map state ~f:render_state

let () = Bonsai_web.Start.start component
