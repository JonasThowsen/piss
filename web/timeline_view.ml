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

let retained_runtime session runtime =
  Option.first_some runtime
    (Option.bind session ~f:(fun (session : Control_plane.Session.t) ->
         session.runtime))

let history_controls ~session ~runtime ~buffer ~on_load_older =
  let snapshot = retained_runtime session runtime in
  let entries = Event_buffer.entries buffer in
  let pending = Event_history.pending_permissions entries in
  let requires_action =
    Option.exists session ~f:(fun session ->
        phys_equal session.Control_plane.Session.status
          Runtime_domain.Requires_action)
    || Option.exists snapshot ~f:(fun runtime ->
        phys_equal runtime.Runtime_domain.status Runtime_domain.Requires_action)
  in
  let can_page =
    Option.exists snapshot ~f:(fun runtime ->
        Event_buffer.can_page_before buffer
          ~first_sequence:runtime.Runtime_domain.first_sequence)
  in
  let loading = Event_buffer.is_loading buffer in
  let retention =
    match snapshot with
    | Some runtime when runtime.retention_pruned ->
        [
          Vdom.Node.p
            ~attrs:
              [
                class_ "timeline-trimmed-notice";
                Vdom.Attr.create "role" "status";
              ]
            [
              text
                ("Earlier ordinary activity was compacted from the durable "
               ^ "session log. Retained history begins at sequence "
                ^ Int64.to_string runtime.first_sequence
                ^ "; permission and command boundaries remain durable.");
            ];
        ]
    | None | Some _ -> []
  in
  let error =
    Option.value_map (Event_buffer.page_error buffer) ~default:[]
      ~f:(fun message ->
        [
          Vdom.Node.p
            ~attrs:
              [
                class_ "timeline-history-warning";
                Vdom.Attr.create "role" "alert";
              ]
            [ text ("Earlier history could not be loaded: " ^ message) ];
        ])
  in
  let permission_gap =
    if
      requires_action && List.is_empty pending && (not loading)
      && ((not can_page) || Option.is_none snapshot)
    then
      [
        Vdom.Node.p
          ~attrs:
            [
              class_ "timeline-history-warning"; Vdom.Attr.create "role" "alert";
            ]
          [
            text
              "The session reports requires_action, but no pending permission \
               request exists in retained history. No approval was inferred; \
               inspect or restart the session to recover explicitly.";
          ];
      ]
    else []
  in
  let paging =
    if can_page || loading then
      [
        Vdom.Node.button
          ~attrs:
            ([
               class_ "load-earlier";
               Vdom.Attr.create "type" "button";
               Vdom.Attr.on_click (fun _ -> on_load_older ());
             ]
            @ if loading then [ Vdom.Attr.create "disabled" "" ] else [])
          [
            text
              (if loading then "Loading earlier activity..."
               else "Load earlier activity");
          ];
      ]
    else []
  in
  retention @ error @ permission_gap @ paging

let timeline state selected_id ~session ~runtime ~deciding_permissions
    ~copy_feedback ~on_copy ~on_permission ~on_load_older =
  let content =
    match (state, selected_id) with
    | Sessions_loading, _ ->
        [
          Timeline_entry_view.empty_state "..." "Loading active sessions..."
            "Waiting for the same-origin control-plane response.";
        ]
    | Sessions_failed message, _ ->
        [
          Timeline_entry_view.empty_state "!" "Could not load sessions." message;
        ]
    | No_sessions, _ ->
        [
          Timeline_entry_view.empty_state "0" "No active sessions."
            "The control plane returned an empty active-session list.";
        ]
    | Awaiting_selection, _ ->
        [
          Timeline_entry_view.empty_state ">" "Select a session."
            "Choose a session to load its recent history.";
        ]
    | Loading _, _ ->
        [
          Timeline_entry_view.empty_state "..." "Loading recent events..."
            "Waiting for the same-origin control-plane response.";
        ]
    | Failed (_, message), _ ->
        [
          Timeline_entry_view.empty_state "!" "Could not load history." message;
        ]
    | Loaded (history_id, buffer), Some selected_id
      when String.equal history_id selected_id ->
        let entries = Event_buffer.entries buffer in
        history_controls ~session ~runtime ~buffer ~on_load_older
        @
        if List.is_empty entries then
          [
            Timeline_entry_view.empty_state "0" "No events yet."
              "The worker has not published a visible timeline event.";
          ]
        else
          List.filter_map entries
            ~f:(Timeline_entry_view.render ~copy_feedback ~on_copy)
          @ Permission_view.render_pending entries
              ~deciding:deciding_permissions ~on_decide:on_permission
    | Loaded _, _ ->
        [
          Timeline_entry_view.empty_state "..." "Loading recent events..."
            "Waiting for the selected session history.";
        ]
  in
  Vdom.Node.div
    ~attrs:
      [
        class_ "timeline";
        Vdom.Attr.id "timeline";
        Vdom.Attr.create "tabindex" "0";
        Vdom.Attr.create "aria-live" "polite";
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

let render ~session ~workspace ~runtime ~runtime_loading ~runtime_error ~tab
    ~on_tab ~state ~composer ~deciding_permissions ~copy_feedback ~on_copy
    ~on_permission ~on_load_older =
  let selected_id =
    Option.map session ~f:(fun (session : Control_plane.Session.t) ->
        session.id)
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
  let outbox_view = Outbox_view.render events in
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
        timeline state selected_id ~session ~runtime ~deciding_permissions
          ~copy_feedback ~on_copy ~on_permission ~on_load_older;
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
          Working_panel.render working ~hidden:(not (phys_equal tab Working));
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
       (match session with
       | None -> Vdom.Node.none
       | Some _ -> render_tabs tab ~on_select:on_tab working);
       Vdom.Node.div ~attrs:[ class_ "session-panel-stack" ] panels;
     ]
    @
    if phys_equal tab Agent then outbox_view :: Option.to_list composer else []
    )
