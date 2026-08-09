open! Core
open! Bonsai_web.Cont

type state =
  | Sessions_loading
  | Sessions_failed of string
  | No_sessions
  | Awaiting_selection
  | Loading of string
  | Loaded of string * Event_buffer.t
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

let copy_button ~key ~kind ~body ~copy_feedback ~on_copy =
  let state =
    match copy_feedback with
    | Some (candidate, status) when String.equal candidate key -> Some status
    | _ -> None
  in
  let adjective, class_name =
    match state with
    | None -> ("Copy", "")
    | Some Clipboard.Copied -> ("Copied", " copied")
    | Some Failed -> ("Copy failed", " failed")
  in
  Vdom.Node.button
    ~attrs:
      [
        class_ ("timeline-copy" ^ class_name);
        Vdom.Attr.create "type" "button";
        Vdom.Attr.create "aria-label" (adjective ^ " " ^ kind);
        Vdom.Attr.on_click (fun _ -> on_copy ~key ~text:body);
      ]
    [ Vdom.Node.b [ text (String.uppercase adjective) ] ]

let message ~key ~class_name ~role ~status ?copy body =
  Vdom.Node.create "article" ~key
    ~attrs:[ class_ ("timeline-item " ^ class_name) ]
    [
      Vdom.Node.div
        ~attrs:[ class_ "message-meta" ]
        [
          Vdom.Node.strong ~attrs:[ class_ "message-role" ] [ text role ];
          Vdom.Node.span ~attrs:[ class_ "message-status" ] [ text status ];
          Option.value copy ~default:Vdom.Node.none;
        ];
      (if String.is_empty body then Vdom.Node.none
       else Vdom.Node.p ~attrs:[ class_ "message-body" ] [ text body ]);
    ]

let render_entry ~copy_feedback ~on_copy = function
  | Event_history.User { sequence; command_id; text = body } ->
      Some
        (message
           ~key:(Int64.to_string sequence ^ "-user")
           ~class_name:"timeline-user" ~role:"You" ~status:command_id body)
  | Agent { sequence = _; message_id; text = body } ->
      let key = "agent:" ^ message_id in
      Some
        (message ~key ~class_name:"timeline-agent" ~role:"Agent"
           ~status:message_id
           ~copy:
             (copy_button ~key ~kind:"message" ~body ~copy_feedback ~on_copy)
           body)
  | Tool { sequence = _; tool_call_id; title; input; output; status; artifacts }
    ->
      let key = "tool:" ^ tool_call_id in
      let detail = Timeline_projection.tool_text ~input ~output ~artifacts in
      Some
        (Vdom.Node.create "article" ~key
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
                     Vdom.Node.div
                       ~attrs:[ class_ "tool-copy-row" ]
                       [
                         copy_button ~key ~kind:"tool output" ~body:detail
                           ~copy_feedback ~on_copy;
                       ];
                     Vdom.Node.p
                       ~attrs:[ class_ "message-body" ]
                       [ text detail ];
                   ];
               ];
           ])
  | Command_state { sequence; command_id; state } ->
      let state = Event_history.command_state_to_string state in
      Some
        (message
           ~key:(Int64.to_string sequence ^ "-command")
           ~class_name:"timeline-command" ~role:"Command"
           ~status:("state / " ^ state) command_id)
  | Permission_requested _ | Permission_resolved _ | Permission_cancelled _ ->
      None

let timeline state selected_id ~deciding_permissions ~copy_feedback ~on_copy
    ~on_permission =
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
    | Loaded (_, buffer), _ when List.is_empty (Event_buffer.entries buffer) ->
        [
          empty_state "0" "No events yet."
            "The worker has not published a visible timeline event.";
        ]
    | Loaded (history_id, buffer), Some selected_id
      when String.equal history_id selected_id ->
        let entries = Event_buffer.entries buffer in
        List.filter_map entries ~f:(render_entry ~copy_feedback ~on_copy)
        @ Permission_view.render_pending entries ~deciding:deciding_permissions
            ~on_decide:on_permission
    | Loaded _, _ ->
        [
          empty_state "..." "Loading recent events..."
            "Waiting for the selected session history.";
        ]
  in
  Vdom.Node.div
    ~attrs:[ class_ "timeline"; Vdom.Attr.id "timeline" ]
    [ Vdom.Node.div ~attrs:[ class_ "timeline-stream" ] content ]

let render ~session ~state ~composer ~deciding_permissions ~copy_feedback
    ~on_copy ~on_permission =
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
         [
           timeline state selected_id ~deciding_permissions ~copy_feedback
             ~on_copy ~on_permission;
           Vdom.Node.button
             ~attrs:
               ([
                  class_ "timeline-jump";
                  Vdom.Attr.create "type" "button";
                  Vdom.Attr.create "aria-label" "Jump to latest message";
                  Vdom.Attr.on_click (fun _ ->
                      Timeline_scroll.jump_to_latest ());
                ]
               @
               if Timeline_scroll.is_following () then
                 [ Vdom.Attr.create "hidden" "" ]
               else [])
             [ Vdom.Node.span [ text "LATEST" ] ];
         ];
     ]
    @ Option.to_list composer)
