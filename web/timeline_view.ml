open! Core
open! Bonsai_web.Cont

type state =
  | Sessions_loading
  | Sessions_failed of string
  | No_sessions
  | Awaiting_selection
  | Loading of string
  | Loaded of string * Event_history.entry list
  | Failed of string * string

let class_ name = Vdom.Attr.class_ name
let text = Vdom.Node.text

let empty_state glyph title message =
  Vdom.Node.div
    ~attrs:[ class_ "empty-state" ]
    [
      Vdom.Node.span [ text glyph ];
      Vdom.Node.h3 [ text title ];
      Vdom.Node.p [ text message ];
    ]

let message ~key ~class_name ~role ~status body =
  Vdom.Node.create "article" ~key
    ~attrs:[ class_ ("timeline-item " ^ class_name) ]
    [
      Vdom.Node.div
        ~attrs:[ class_ "message-meta" ]
        [
          Vdom.Node.strong ~attrs:[ class_ "message-role" ] [ text role ];
          Vdom.Node.span ~attrs:[ class_ "message-status" ] [ text status ];
        ];
      (if String.is_empty body then Vdom.Node.none
       else Vdom.Node.p ~attrs:[ class_ "message-body" ] [ text body ]);
    ]

let render_entry = function
  | Event_history.User { sequence; command_id; text = body } ->
      message
        ~key:(Int64.to_string sequence ^ "-user")
        ~class_name:"timeline-user" ~role:"You" ~status:command_id body
  | Agent { sequence; message_id; text = body } ->
      message
        ~key:(Int64.to_string sequence ^ "-agent")
        ~class_name:"timeline-agent" ~role:"Agent" ~status:message_id body
  | Tool { sequence; tool_call_id; title; detail; status } ->
      Vdom.Node.create "article"
        ~key:(Int64.to_string sequence ^ "-tool")
        ~attrs:[ class_ "timeline-item timeline-tool" ]
        [
          Vdom.Node.create "details"
            ~attrs:[ class_ "tool-disclosure" ]
            [
              Vdom.Node.create "summary"
                [
                  Vdom.Node.span
                    ~attrs:[ class_ "tool-disclosure-icon" ]
                    [ text ">" ];
                  Vdom.Node.strong
                    ~attrs:[ class_ "message-role" ]
                    [ text title ];
                  Vdom.Node.span
                    ~attrs:[ class_ "message-status" ]
                    [ text status ];
                ];
              Vdom.Node.div
                ~attrs:[ class_ "timeline-contents" ]
                [
                  Vdom.Node.p
                    ~attrs:[ class_ "message-status" ]
                    [ text tool_call_id ];
                  Vdom.Node.p ~attrs:[ class_ "message-body" ] [ text detail ];
                ];
            ];
        ]
  | Command_state { sequence; command_id; state } ->
      let state = Event_history.command_state_to_string state in
      message
        ~key:(Int64.to_string sequence ^ "-command")
        ~class_name:"timeline-command" ~role:"Command"
        ~status:("state / " ^ state) command_id

let timeline state selected_id =
  let content =
    match (state, selected_id) with
    | Sessions_loading, _ ->
        [
          empty_state "..." "Loading active sessions..."
            "Waiting for the same-origin control-plane response.";
        ]
    | Sessions_failed message, _ ->
        [ empty_state "!" "Could not load sessions." message ]
    | No_sessions, _ ->
        [
          empty_state "0" "No active sessions."
            "The control plane returned an empty active-session list.";
        ]
    | Awaiting_selection, _ ->
        [
          empty_state ">" "Select a session."
            "Choose a session to load its recent history.";
        ]
    | Loading _, _ ->
        [
          empty_state "..." "Loading recent events..."
            "Waiting for the same-origin control-plane response.";
        ]
    | Failed (_, message), _ ->
        [ empty_state "!" "Could not load history." message ]
    | Loaded (_, []), _ ->
        [
          empty_state "0" "No events yet."
            "The worker has not published a visible timeline event.";
        ]
    | Loaded (history_id, entries), Some selected_id
      when String.equal history_id selected_id ->
        List.map entries ~f:render_entry
    | Loaded _, _ ->
        [
          empty_state "..." "Loading recent events..."
            "Waiting for the selected session history.";
        ]
  in
  Vdom.Node.div
    ~attrs:[ class_ "timeline" ]
    [ Vdom.Node.div ~attrs:[ class_ "timeline-stream" ] content ]

let composer ~prompt ~submitting ~notice ~on_prompt ~on_submit =
  Vdom.Node.div
    ~attrs:[ class_ "composer-wrap" ]
    [
      Vdom.Node.p ~attrs:[ class_ "notice" ] [ text notice ];
      Vdom.Node.form
        ~attrs:
          [
            class_ "composer";
            Vdom.Attr.on_submit (fun _ ->
                Effect.Many
                  [
                    on_submit ();
                    Vdom.Effect.Prevent_default;
                    Vdom.Effect.Stop_propagation;
                  ]);
          ]
        [
          Vdom.Node.textarea
            ~attrs:
              [
                Vdom.Attr.string_property "value" prompt;
                Vdom.Attr.create "aria-label" "Message agent";
                Vdom.Attr.placeholder "Send a plain text prompt";
                Vdom.Attr.on_input (fun _ value -> on_prompt value);
              ]
            [];
          Vdom.Node.div
            ~attrs:[ class_ "composer-actions" ]
            [
              Vdom.Node.span [ text "PLAIN TEXT" ];
              Vdom.Node.button
                ~attrs:
                  ([
                     class_ "send-action";
                     Vdom.Attr.create "type" "submit";
                     Vdom.Attr.create "aria-label" "Send message";
                   ]
                  @
                  if submitting || String.is_empty (String.strip prompt) then
                    [ Vdom.Attr.create "disabled" "" ]
                  else [])
                [ text (if submitting then "..." else ">") ];
            ];
        ];
    ]

let render ~session ~state ~prompt ~submitting ~notice ~on_prompt ~on_submit =
  let selected_id =
    Option.map session ~f:(fun (session : Control_plane.Session.t) ->
        session.id)
  in
  let title =
    Option.value_map session ~default:"Active sessions"
      ~f:(fun (session : Control_plane.Session.t) -> session.title)
  in
  Vdom.Node.section
    ~attrs:[ class_ "conversation-panel" ]
    ([
       Vdom.Node.header
         ~attrs:[ class_ "conversation-heading" ]
         [
           Vdom.Node.h2 [ text title ];
           Vdom.Node.span
             ~attrs:[ class_ "sequence-label" ]
             [
               text
                 (Option.value_map selected_id ~default:"GET /api/v2/sessions"
                    ~f:(fun id -> "session / " ^ id));
             ];
         ];
       Vdom.Node.div
         ~attrs:[ class_ "timeline-wrap" ]
         [ timeline state selected_id ];
     ]
    @
    match session with
    | None -> []
    | Some _ -> [ composer ~prompt ~submitting ~notice ~on_prompt ~on_submit ])
