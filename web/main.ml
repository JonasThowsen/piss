open! Core
open! Bonsai_web.Cont
open Bonsai.Let_syntax
open App_state

let class_ name = [ Vdom.Attr.class_ name ]

let catalog_request () =
  Async_kernel.Deferred.all
    [
      Browser_http.get "/api/v2/workspaces";
      Browser_http.get "/api/v2/sessions";
      Browser_http.get ~query:[ ("archived", "true") ] "/api/v2/sessions";
    ]

let decode_catalog = function
  | [ Ok workspace_body; Ok session_body; Ok archived_body ] -> (
      match
        ( Workspace_catalog.decode workspace_body,
          Control_plane.decode_sessions session_body,
          Control_plane.decode_archived_sessions archived_body )
      with
      | Ok workspaces, Ok sessions, Ok archived ->
          Ok (workspaces, sessions, archived)
      | Error message, _, _ | _, Error message, _ | _, _, Error message ->
          Error message)
  | responses -> (
      match List.find_map responses ~f:Result.error with
      | Some error -> Error (Error.to_string_hum error)
      | None -> Error "catalog response was incomplete")

let refresh_catalog ~set_workspaces ~set_sessions ~set_archived =
  Effect.bind (Effect.of_deferred_thunk catalog_request) ~f:(fun response ->
      match decode_catalog response with
      | Error _ -> Effect.Ignore
      | Ok (workspaces, sessions, archived) ->
          Effect.Many
            [
              set_workspaces workspaces;
              set_sessions (Session_rail.Loaded sessions);
              set_archived archived;
            ])

let load_snapshot ~inject_shell session_id =
  Effect.bind (inject_shell (Runtime_start session_id)) ~f:(fun () ->
      Effect.bind
        (Effect.of_deferred_thunk (fun () ->
             Browser_http.get
               ~query:[ ("session", session_id) ]
               "/api/v2/session"))
        ~f:(function
          | Error error ->
              inject_shell
                (Runtime_failed (session_id, Error.to_string_hum error))
          | Ok body -> (
              match Runtime_domain.decode ~expected_session:session_id body with
              | Error message ->
                  inject_shell (Runtime_failed (session_id, message))
              | Ok snapshot ->
                  inject_shell (Runtime_loaded (session_id, snapshot)))))

let component graph =
  let sessions, set_sessions = Bonsai.state Session_rail.Loading graph in
  let archived, set_archived = Bonsai.state [] graph in
  let workspaces, set_workspaces = Bonsai.state [] graph in
  let selected_id, set_selected_id = Bonsai.state None graph in
  let mobile_open, set_mobile_open = Bonsai.state false graph in
  let collapsed, set_collapsed = Bonsai.state String.Set.empty graph in
  let menu_open, set_menu_open = Bonsai.state None graph in
  let shell, inject_shell =
    Bonsai.state_machine0
      ~default_model:{ runtime = empty_runtime; tab = Session_tabs.Agent }
      ~apply_action:apply_shell
      ~sexp_of_model:(fun _ -> Sexp.Atom "shell")
      ~sexp_of_action:(fun _ -> Sexp.Atom "shell-action")
      graph
  in
  let history, inject_history =
    Bonsai.state_machine0 ~default_model:Timeline_view.Sessions_loading
      ~apply_action:apply_history
      ~sexp_of_model:(fun _ -> Sexp.Atom "history")
      ~sexp_of_action:(fun _ -> Sexp.Atom "history-action")
      graph
  in
  let deciding_permissions, inject_deciding =
    Bonsai.state_machine0 ~default_model:String.Set.empty
      ~apply_action:apply_deciding
      ~sexp_of_model:(fun _ -> Sexp.Atom "deciding")
      ~sexp_of_action:(fun _ -> Sexp.Atom "deciding-action")
      graph
  in
  let stream_notice, set_stream_notice = Bonsai.state "" graph in
  let composer_notice, set_composer_notice = Bonsai.state "" graph in
  let copy_feedback, set_copy_feedback = Bonsai.state None graph in
  let composer_busy, set_composer_busy = Bonsai.state false graph in
  let selected =
    let%arr sessions = sessions and selected_id = selected_id in
    Session_rail.selected sessions selected_id
  in
  let runtime =
    let%arr shell = shell and selected_id = selected_id in
    match (shell.runtime.session_id, selected_id) with
    | Some runtime_id, Some selected_id when String.equal runtime_id selected_id
      ->
        shell.runtime.snapshot
    | _ -> None
  in
  let permission_recovery =
    let%arr selected = selected and runtime = runtime and history = history in
    match (selected, history) with
    | Some session, Timeline_view.Loaded (history_id, buffer)
      when String.equal session.id history_id ->
        let snapshot = Option.first_some runtime session.runtime in
        let requires_action =
          phys_equal session.status Runtime_domain.Requires_action
          || Option.exists snapshot ~f:(fun snapshot ->
              phys_equal snapshot.status Runtime_domain.Requires_action)
        in
        let no_pending =
          Event_buffer.entries buffer
          |> Event_history.pending_permissions |> List.is_empty
        in
        if requires_action && no_pending then
          Option.bind snapshot ~f:(fun snapshot ->
              if
                Event_buffer.can_page_before buffer
                  ~first_sequence:snapshot.first_sequence
              then
                Option.map (Event_buffer.earliest_sequence buffer)
                  ~f:(fun before -> (session.id, before))
              else None)
        else None
    | None, _ | Some _, _ -> None
  in
  let recover_permission =
    let%arr inject_history = inject_history
    and set_stream_notice = set_stream_notice in
    function
    | None -> Effect.Ignore
    | Some (session_id, before) ->
        History_loader.load_older ~inject_history ~set_stream_notice ~session_id
          ~before
  in
  Bonsai.Edge.on_change permission_recovery
    ~equal:
      (Option.equal (fun (left_id, left_before) (right_id, right_before) ->
           String.equal left_id right_id && Int64.equal left_before right_before))
    ~callback:recover_permission graph;
  let refresh_runtime =
    let%arr selected_id = selected_id and inject_shell = inject_shell in
    Option.value_map selected_id ~default:Effect.Ignore ~f:(fun id ->
        load_snapshot ~inject_shell id)
  in
  let config_available =
    let%arr shell = shell and composer_busy = composer_busy in
    (not shell.runtime.loading)
    && Option.is_none shell.runtime.error
    && not composer_busy
  in
  let config_controls =
    Config_controls.component runtime ~available:config_available
      ~refresh:refresh_runtime ~on_error:set_stream_notice graph
  in
  let composer =
    let connecting =
      let%arr shell = shell in
      shell.runtime.loading
    in
    Composer.component selected runtime connecting stream_notice composer_notice
      config_controls ~set_notice:set_composer_notice ~on_busy:set_composer_busy
      ~refresh_runtime graph
  in
  let visible_history =
    let%arr sessions = sessions and history = history in
    match sessions with
    | Session_rail.Loading -> Timeline_view.Sessions_loading
    | Session_rail.Failed message -> Sessions_failed message
    | Session_rail.Loaded [] -> No_sessions
    | Session_rail.Loaded (_ :: _) -> history
  in
  let selected_workspace =
    let%arr workspaces = workspaces and session = selected in
    App_header.selected_workspace workspaces session
  in
  let decide_permission =
    let%arr session = selected
    and runtime = runtime
    and deciding_permissions = deciding_permissions
    and inject_deciding = inject_deciding
    and set_composer_notice = set_composer_notice in
    fun ~request_id ~option_id ->
      match (session, runtime) with
      | None, _ | _, None -> Effect.Ignore
      | Some _, Some _ when Set.mem deciding_permissions request_id ->
          Effect.Ignore
      | Some session, Some runtime ->
          Effect.bind (inject_deciding (Add request_id)) ~f:(fun () ->
              Effect.bind
                (Effect.of_deferred_thunk (fun () ->
                     Browser_http.post_json
                       ~query:[ ("session", session.id) ]
                       "/api/v2/permissions"
                       (Permission_decision.to_yojson runtime
                          ~mutation_id:(Command_id.create ()) ~request_id
                          ~option_id)))
                ~f:(function
                  | Error error ->
                      Effect.Many
                        [
                          inject_deciding (Remove request_id);
                          set_composer_notice (Error.to_string_hum error);
                        ]
                  | Ok _ ->
                      set_composer_notice
                        "Decision submitted. Waiting for the session event."))
  in
  let copy_timeline =
    let%arr set_copy_feedback = set_copy_feedback in
    fun ~key ~text -> Clipboard.copy ~key ~text ~on_change:set_copy_feedback
  in
  let load_older =
    let%arr session = selected
    and runtime = runtime
    and visible_history = visible_history
    and inject_history = inject_history
    and set_stream_notice = set_stream_notice in
    fun () ->
      match (session, visible_history) with
      | Some session, Timeline_view.Loaded (history_id, buffer)
        when String.equal session.id history_id -> (
          let snapshot = Option.first_some runtime session.runtime in
          match snapshot with
          | Some snapshot
            when Event_buffer.can_page_before buffer
                   ~first_sequence:snapshot.first_sequence ->
              Option.value_map (Event_buffer.earliest_sequence buffer)
                ~default:Effect.Ignore ~f:(fun before ->
                  History_loader.load_older ~inject_history ~set_stream_notice
                    ~session_id:session.id ~before)
          | None | Some _ -> Effect.Ignore)
      | None, _ | Some _, _ -> Effect.Ignore
  in
  let timeline_content =
    let%arr session = selected
    and runtime = runtime
    and visible_history = visible_history
    and selected_id = selected_id
    and deciding_permissions = deciding_permissions
    and copy_feedback = copy_feedback
    and on_copy = copy_timeline
    and on_permission = decide_permission
    and on_load_older = load_older in
    ( Timeline_view.render_timeline visible_history selected_id ~session
        ~runtime ~deciding_permissions ~copy_feedback ~on_copy ~on_permission
        ~on_load_older,
      Timeline_view.render_outbox visible_history selected_id )
  in
  let load =
    let%arr set_sessions = set_sessions
    and set_workspaces = set_workspaces
    and set_archived = set_archived
    and set_menu_open = set_menu_open
    and selected_id = selected_id
    and set_selected_id = set_selected_id
    and inject_history = inject_history
    and inject_deciding = inject_deciding
    and inject_shell = inject_shell
    and set_stream_notice = set_stream_notice
    and composer = composer in
    Effect.bind (Effect.of_deferred_thunk catalog_request) ~f:(fun response ->
        match decode_catalog response with
        | Error message -> set_sessions (Session_rail.Failed message)
        | Ok (next_workspaces, next_sessions, next_archived) ->
            let selected_still_active =
              Option.exists selected_id ~f:(fun selected ->
                  List.exists next_sessions
                    ~f:(fun (session : Control_plane.Session.t) ->
                      String.equal session.id selected))
            in
            let next_id =
              if composer.has_pending () && selected_still_active then
                selected_id
              else
                Workspace_catalog.reconcile_selection ~previous:selected_id
                  next_sessions
            in
            let catalog_refresh =
              refresh_catalog ~set_workspaces ~set_sessions ~set_archived
            in
            Effect.bind
              (Effect.Many
                 [
                   set_workspaces next_workspaces;
                   set_sessions (Session_rail.Loaded next_sessions);
                   set_archived next_archived;
                   set_selected_id next_id;
                   set_menu_open None;
                 ])
              ~f:(fun () ->
                Option.value_map next_id
                  ~default:
                    (Effect.of_deferred_thunk (fun () ->
                         Event_stream.close ();
                         Async_kernel.Deferred.return ()))
                  ~f:(fun id ->
                    let snapshot_refresh = load_snapshot ~inject_shell id in
                    Effect.Many
                      [
                        snapshot_refresh;
                        History_loader.load_initial ~inject_history
                          ~inject_deciding
                          ~refresh_catalog_effect:catalog_refresh
                          ~refresh_snapshot_effect:snapshot_refresh
                          ~set_stream_notice id;
                      ])))
  in
  let select_session =
    let%arr selected_id = selected_id
    and set_selected_id = set_selected_id
    and set_mobile_open = set_mobile_open
    and set_menu_open = set_menu_open
    and inject_shell = inject_shell
    and inject_history = inject_history
    and inject_deciding = inject_deciding
    and set_stream_notice = set_stream_notice
    and set_sessions = set_sessions
    and set_workspaces = set_workspaces
    and set_archived = set_archived
    and composer = composer in
    fun id ->
      if Option.exists selected_id ~f:(String.equal id) then
        Effect.Many [ set_mobile_open false; set_menu_open None ]
      else if composer.has_pending () then
        composer.set_notice
          "Retry or abandon the uncertain command before switching sessions."
      else
        let catalog_refresh =
          refresh_catalog ~set_workspaces ~set_sessions ~set_archived
        in
        let snapshot_refresh = load_snapshot ~inject_shell id in
        Effect.bind (Timeline_scroll.reset ()) ~f:(fun () ->
            Effect.bind (set_selected_id (Some id)) ~f:(fun () ->
                Effect.Many
                  [
                    composer.reset ();
                    set_stream_notice "";
                    set_mobile_open false;
                    set_menu_open None;
                    catalog_refresh;
                    snapshot_refresh;
                    History_loader.load_initial ~inject_history ~inject_deciding
                      ~refresh_catalog_effect:catalog_refresh
                      ~refresh_snapshot_effect:snapshot_refresh
                      ~set_stream_notice id;
                  ]))
  in
  let active_sessions =
    let%arr sessions = sessions in
    match sessions with Session_rail.Loaded values -> values | _ -> []
  in
  let harnesses =
    let%arr active = active_sessions and archived = archived in
    Global_search.available_harnesses ~active ~archived
  in
  let lifecycle =
    Session_lifecycle.component ~harnesses ~on_reload:load
      ~on_select:select_session graph
  in
  let workspace_dialogs = Workspace_dialogs.component ~on_reload:load graph in
  let close_navigation =
    let%arr set_mobile_open = set_mobile_open
    and set_menu_open = set_menu_open in
    Effect.Many [ set_mobile_open false; set_menu_open None ]
  in
  let search =
    Search_dialog.component ~workspaces ~active:active_sessions ~archived
      ~on_open:close_navigation ~on_reload:load ~on_select:select_session graph
  in
  let close_stream =
    let%arr () = Bonsai.return () in
    Effect.of_deferred_thunk (fun () ->
        Event_stream.close ();
        Async_kernel.Deferred.return ())
  in
  let activate =
    let%arr load = load
    and set_mobile_open = set_mobile_open
    and set_menu_open = set_menu_open in
    Effect.bind
      (Mobile_shell.start ~on_escape:(fun () ->
           Effect.Many [ set_mobile_open false; set_menu_open None ]))
      ~f:(fun () -> Effect.bind (Timeline_scroll.start ()) ~f:(fun () -> load))
  in
  let deactivate =
    let%arr close_stream = close_stream in
    Effect.Many
      [
        close_stream;
        Timeline_scroll.cleanup ();
        Clipboard.cleanup ();
        Modal.cleanup ();
        Search_dialog.cleanup ();
        Mobile_shell.cleanup ();
      ]
  in
  Bonsai.Edge.lifecycle ~on_activate:activate ~on_deactivate:deactivate graph;
  let%arr sessions = sessions
  and workspaces = workspaces
  and selected_id = selected_id
  and session = selected
  and workspace = selected_workspace
  and mobile_open = mobile_open
  and collapsed = collapsed
  and menu_open = menu_open
  and shell = shell
  and runtime = runtime
  and timeline_content = timeline_content
  and composer = composer
  and lifecycle = lifecycle
  and workspace_dialogs = workspace_dialogs
  and search = search
  and select_session = select_session
  and set_mobile_open = set_mobile_open
  and set_collapsed = set_collapsed
  and set_menu_open = set_menu_open
  and inject_shell = inject_shell in
  let timeline, outbox = timeline_content in
  let select = select_session in
  let close_mobile () =
    Effect.Many [ set_mobile_open false; Mobile_shell.focus_menu_button () ]
  in
  let open_mobile () =
    Effect.Many [ set_mobile_open true; Mobile_shell.focus_navigation () ]
  in
  let toggle_mobile () =
    if mobile_open then close_mobile () else open_mobile ()
  in
  let toggle_workspace id =
    set_collapsed
      (if Set.mem collapsed id then Set.remove collapsed id
       else Set.add collapsed id)
  in
  let select_tab tab =
    if phys_equal tab Session_tabs.Agent then
      Effect.bind (inject_shell (Select_tab tab)) ~f:(fun () ->
          Timeline_scroll.resume ())
    else inject_shell (Select_tab tab)
  in
  let open_modal action =
    Effect.bind
      (Effect.Many [ set_mobile_open false; set_menu_open None ])
      ~f:(fun () -> action)
  in
  Vdom.Node.div ~attrs:(class_ "app-shell")
    [
      Vdom.Node.main
        ~attrs:([ Vdom.Attr.id "control-room" ] @ class_ "control-room")
        [
          App_header.render sessions workspaces selected_id runtime
            (Mobile_shell.menu_button ~open_:mobile_open
               ~on_toggle:toggle_mobile)
            search.trigger;
          Vdom.Node.section ~attrs:(class_ "workspace-grid")
            [
              Mobile_shell.scrim ~open_:mobile_open ~on_close:close_mobile;
              Session_rail.render sessions ~workspaces ~selected_id ~collapsed
                ~menu_open ~mobile_open ~on_toggle:toggle_workspace
                ~on_menu:set_menu_open
                ~on_select:(fun id ->
                  Effect.Many [ set_menu_open None; select id ])
                ~on_add_workspace:(fun () ->
                  open_modal (workspace_dialogs.open_add ()))
                ~on_remove_workspace:(fun workspace ->
                  open_modal (workspace_dialogs.open_remove workspace))
                ~on_create:(fun workspace ->
                  open_modal (lifecycle.open_create workspace))
                ~on_rename:(fun session ->
                  open_modal (lifecycle.open_rename session))
                ~on_archive:(fun session ->
                  if composer.has_pending () then
                    composer.set_notice
                      "Retry or abandon the uncertain command before archiving \
                       its session."
                  else open_modal (lifecycle.open_archive session));
              Timeline_view.render ~session ~workspace ~runtime
                ~runtime_loading:shell.runtime.loading
                ~runtime_error:shell.runtime.error ~tab:shell.tab
                ~on_tab:select_tab ~timeline ~outbox
                ~composer:(Some composer.view);
            ];
        ];
      search.view;
      lifecycle.view;
      workspace_dialogs.view;
    ]

let () = Bonsai_web.Start.start component
