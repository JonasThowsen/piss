open! Core
open! Bonsai_web.Cont
open Js_of_ocaml
open Session_tabs

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

let event_key event =
  try
    Js.to_string
      (Js.Unsafe.coerce (Js.Unsafe.get (Js.Unsafe.inject event) "key"))
  with _ -> ""

let focus_tab tab =
  Effect.of_deferred_thunk (fun () ->
      let id = "session-tab-" ^ Session_tabs.id tab in
      let element =
        Js.Unsafe.meth_call
          (Js.Unsafe.inject Dom_html.document)
          "getElementById"
          [| Js.Unsafe.inject (Js.string id) |]
      in
      (try ignore (Js.Unsafe.meth_call element "focus" [||]) with _ -> ());
      Async_kernel.Deferred.return ())

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
    ~attrs:
      [
        class_ "timeline";
        Vdom.Attr.id "timeline";
        Vdom.Attr.on_scroll (fun _ -> Timeline_scroll.track ());
      ]
    [ Vdom.Node.div ~attrs:[ class_ "timeline-stream" ] content ]

let render_tabs selected ~on_select working =
  let button tab =
    let active = phys_equal selected tab in
    let keydown event =
      match Session_tabs.navigate ~current:tab ~key:(event_key event) with
      | None -> Effect.Ignore
      | Some next ->
          Effect.Many
            [ Vdom.Effect.Prevent_default; on_select next; focus_tab next ]
    in
    Vdom.Node.button
      ~attrs:
        [
          Vdom.Attr.id ("session-tab-" ^ Session_tabs.id tab);
          class_
            ((if phys_equal tab Session_tabs.Working then "working-tab " else "")
            ^ if active then "active" else "");
          Vdom.Attr.create "type" "button";
          Vdom.Attr.create "role" "tab";
          Vdom.Attr.create "aria-selected" (Bool.to_string active);
          Vdom.Attr.create "aria-controls"
            ("session-panel-" ^ Session_tabs.id tab);
          Vdom.Attr.create "tabindex" (if active then "0" else "-1");
          Vdom.Attr.on_keydown keydown;
          Vdom.Attr.on_click (fun _ -> on_select tab);
        ]
      ([ text (Session_tabs.label tab) ]
      @
      if phys_equal tab Session_tabs.Working then
        [
          Vdom.Node.create "i"
            ~attrs:
              [
                class_
                  ("working-tab-pulse working-tab-pulse-"
                  ^
                  match working.Working_view.phase with
                  | Running_tool -> "running"
                  | Thinking -> "thinking"
                  | Awaiting_permission -> "awaiting"
                  | Connecting -> "connecting"
                  | Idle -> "idle");
                Vdom.Attr.create "aria-hidden" "true";
              ]
            [];
        ]
      else [])
  in
  Vdom.Node.div
    ~attrs:
      [
        class_ "capability-tabs";
        Vdom.Attr.create "role" "tablist";
        Vdom.Attr.create "aria-label" "Session views";
      ]
    [
      button Agent;
      button Working;
      Vdom.Node.button
        ~attrs:
          [
            Vdom.Attr.create "type" "button";
            Vdom.Attr.create "role" "tab";
            Vdom.Attr.create "aria-selected" "false";
            Vdom.Attr.create "aria-disabled" "true";
            Vdom.Attr.create "disabled" "";
          ]
        [ text "Changes" ];
      button Details;
    ]

let working_tool_card (tool : Working_view.tool) =
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

let render_working model ~hidden =
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
            ~f:working_tool_card;
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

let render ~session ~workspace ~runtime ~runtime_loading ~runtime_error ~tab
    ~on_tab ~state ~composer ~deciding_permissions ~copy_feedback ~on_copy
    ~on_permission =
  let selected_id =
    Option.map session ~f:(fun (session : Control_plane.Session.t) ->
        session.id)
  in
  let title =
    Option.value_map session ~default:"Active sessions"
      ~f:(fun (session : Control_plane.Session.t) -> session.title)
  in
  let events, entries =
    match (state, selected_id) with
    | Loaded (history_id, buffer), Some selected_id
      when String.equal history_id selected_id ->
        (Event_buffer.events buffer, Event_buffer.entries buffer)
    | _ -> ([], [])
  in
  let working =
    Working_view.derive ~snapshot:runtime ~connecting:runtime_loading ~events
      ~entries
  in
  let agent_panel =
    Vdom.Node.div
      ~attrs:
        ([
           Vdom.Attr.id "session-panel-agent";
           class_ "timeline-wrap";
           Vdom.Attr.create "role" "tabpanel";
           Vdom.Attr.create "aria-labelledby" "session-tab-agent";
         ]
        @ if phys_equal tab Agent then [] else [ Vdom.Attr.create "hidden" "" ]
        )
      [
        timeline state selected_id ~deciding_permissions ~copy_feedback ~on_copy
          ~on_permission;
        Vdom.Node.button
          ~attrs:
            ([
               class_ "timeline-jump";
               Vdom.Attr.create "type" "button";
               Vdom.Attr.create "aria-label" "Jump to latest message";
               Vdom.Attr.on_click (fun _ -> Timeline_scroll.jump_to_latest ());
             ]
            @
            if Timeline_scroll.is_following () then
              [ Vdom.Attr.create "hidden" "" ]
            else [])
          [ Vdom.Node.span [ text "LATEST" ] ];
      ]
  in
  let panels =
    match session with
    | None -> [ agent_panel ]
    | Some session ->
        [
          agent_panel;
          render_working working ~hidden:(not (phys_equal tab Working));
          Vdom.Node.div
            ~attrs:
              ([
                 Vdom.Attr.id "session-panel-details";
                 class_ "details-panel";
                 Vdom.Attr.create "role" "tabpanel";
                 Vdom.Attr.create "aria-labelledby" "session-tab-details";
               ]
              @
              if phys_equal tab Details then []
              else [ Vdom.Attr.create "hidden" "" ])
            [
              Details_view.render ~session ~workspace ~runtime
                ~loading:runtime_loading ~error:runtime_error;
            ];
        ]
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
       (match session with
       | None -> Vdom.Node.none
       | Some _ -> render_tabs tab ~on_select:on_tab working);
       Vdom.Node.div ~attrs:[ class_ "session-panel-stack" ] panels;
     ]
    @ if phys_equal tab Agent then Option.to_list composer else [])
