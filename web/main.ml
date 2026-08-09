open! Core
open! Bonsai_web.Cont
open Bonsai.Let_syntax

let class_ name = [ Vdom.Attr.class_ name ]
let text = Vdom.Node.text
let live_event_capacity = 4096

type history_action =
  | Start of string
  | Initial of string * Event_history.event list
  | Append of string * Event_history.event
  | History_failed of string * string

type deciding_action = Add of string | Remove of string | Reset

type runtime_state = {
  session_id : string option;
  snapshot : Runtime_domain.t option;
  loading : bool;
  error : string option;
}

type shell_model = { runtime : runtime_state; tab : Session_tabs.t }

type shell_action =
  | Runtime_start of string
  | Runtime_loaded of string * Runtime_domain.t
  | Runtime_failed of string * string
  | Select_tab of Session_tabs.t

let empty_runtime =
  { session_id = None; snapshot = None; loading = false; error = None }

let apply_shell _ model = function
  | Runtime_start session_id ->
      if Option.exists model.runtime.session_id ~f:(String.equal session_id)
      then
        {
          model with
          runtime = { model.runtime with loading = true; error = None };
        }
      else
        {
          runtime =
            {
              session_id = Some session_id;
              snapshot = None;
              loading = true;
              error = None;
            };
          tab = Agent;
        }
  | Runtime_loaded (session_id, snapshot)
    when Option.exists model.runtime.session_id ~f:(String.equal session_id) ->
      let previous =
        Option.map model.runtime.snapshot ~f:(fun value -> value.status)
      in
      {
        runtime =
          {
            session_id = Some session_id;
            snapshot = Some snapshot;
            loading = false;
            error = None;
          };
        tab =
          Session_tabs.select_after_snapshot ~previous ~next:snapshot.status
            model.tab;
      }
  | Runtime_failed (session_id, message)
    when Option.exists model.runtime.session_id ~f:(String.equal session_id) ->
      {
        model with
        runtime = { model.runtime with loading = false; error = Some message };
      }
  | Runtime_loaded _ | Runtime_failed _ -> model
  | Select_tab tab -> { model with tab }

let apply_history _ state = function
  | Start session_id -> Timeline_view.Loading session_id
  | Initial (session_id, events) -> (
      match state with
      | Timeline_view.Loading current when String.equal current session_id ->
          Loaded
            ( session_id,
              Event_buffer.create ~live_capacity:live_event_capacity events )
      | _ -> state)
  | Append (session_id, event) -> (
      match state with
      | Timeline_view.Loaded (current, buffer)
        when String.equal current session_id ->
          Loaded (current, Event_buffer.add buffer event)
      | _ -> state)
  | History_failed (session_id, message) -> (
      match state with
      | Timeline_view.Loading current when String.equal current session_id ->
          Failed (session_id, message)
      | _ -> state)

let apply_deciding _ deciding = function
  | Add request_id -> Set.add deciding request_id
  | Remove request_id -> Set.remove deciding request_id
  | Reset -> String.Set.empty

let selected_workspace workspaces session =
  Option.bind session ~f:(fun (session : Control_plane.Session.t) ->
      Workspace_catalog.find_workspace workspaces session.workspace_id)

let render_header sessions workspaces selected_id
    (runtime : Runtime_domain.t option) mobile_menu =
  let selected = Session_rail.selected sessions selected_id in
  let workspace = selected_workspace workspaces selected in
  let status, status_class =
    match (sessions, selected, runtime) with
    | Session_rail.Loading, _, _ -> ("loading", "running")
    | Session_rail.Failed _, _, _ -> ("offline", "offline")
    | Session_rail.Loaded [], _, _ -> ("idle", "idle")
    | Session_rail.Loaded _, Some _, Some runtime ->
        let status = Runtime_domain.status_to_string runtime.status in
        (status, status)
    | Session_rail.Loaded _, Some session, None ->
        let status = Control_plane.Session.status_to_string session.status in
        (status, status)
    | Session_rail.Loaded _, None, _ -> ("idle", "idle")
  in
  let title =
    Option.value_map selected ~default:"PISS" ~f:(fun session -> session.title)
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
      Vdom.Node.div
        ~attrs:(class_ ("connection-pill connection-" ^ status_class))
        [ Vdom.Node.create "i" []; Vdom.Node.span [ text status ] ];
    ]

let history_request session_id =
  Browser_http.get
    ~query:[ ("recent", "500"); ("session", session_id) ]
    "/api/v2/events"

let catalog_request () =
  Async_kernel.Deferred.both
    (Browser_http.get "/api/v2/workspaces")
    (Browser_http.get "/api/v2/sessions")

let decode_catalog = function
  | Error error, _ | _, Error error -> Error (Error.to_string_hum error)
  | Ok workspace_body, Ok session_body -> (
      match
        ( Workspace_catalog.decode workspace_body,
          Control_plane.decode_sessions session_body )
      with
      | Ok workspaces, Ok sessions -> Ok (workspaces, sessions)
      | Error message, _ | _, Error message -> Error message)

let refresh_catalog ~set_workspaces ~set_sessions =
  Effect.bind (Effect.of_deferred_thunk catalog_request) ~f:(fun response ->
      match decode_catalog response with
      | Error _ -> Effect.Ignore
      | Ok (workspaces, sessions) ->
          Effect.Many
            [
              set_workspaces workspaces;
              set_sessions (Session_rail.Loaded sessions);
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

let terminal_permission event =
  match Event_history.project [ event ] with
  | [ Event_history.Permission_resolved { request_id; _ } ]
  | [ Permission_cancelled { request_id; _ } ] ->
      Some request_id
  | _ -> None

let dispatch action = Vdom.Effect.Expert.handle_non_dom_event_exn action

let connect_stream ~selection ~session_id ~after ~inject_history
    ~inject_deciding ~refresh_catalog_effect ~refresh_snapshot_effect
    ~set_stream_notice =
  let on_event body =
    match Event_history.decode_event body with
    | Error message ->
        dispatch (set_stream_notice ("Live event rejected: " ^ message))
    | Ok event ->
        let effects =
          [ inject_history (Append (session_id, event)) ]
          @ Option.value_map (terminal_permission event) ~default:[]
              ~f:(fun request_id -> [ inject_deciding (Remove request_id) ])
          @
          if Event_history.refreshes_session event then
            [ refresh_catalog_effect; refresh_snapshot_effect ]
          else []
        in
        dispatch (Effect.Many effects)
  in
  let on_open () = dispatch (set_stream_notice "") in
  let on_error () =
    dispatch (set_stream_notice "Event stream reconnecting...")
  in
  Effect.of_deferred_thunk (fun () ->
      (match
         Event_stream.connect selection ~after ~on_event ~on_open ~on_error
       with
      | Ok () -> ()
      | Error message -> dispatch (set_stream_notice message));
      Async_kernel.Deferred.return ())

let load_history ~inject_history ~inject_deciding ~refresh_catalog_effect
    ~refresh_snapshot_effect ~set_stream_notice session_id =
  let selection = Event_stream.select ~session_id in
  Effect.bind (inject_deciding Reset) ~f:(fun () ->
      Effect.bind (inject_history (Start session_id)) ~f:(fun () ->
          Effect.bind
            (Effect.of_deferred_thunk (fun () -> history_request session_id))
            ~f:(function
              | Error error ->
                  inject_history
                    (History_failed (session_id, Error.to_string_hum error))
              | Ok body -> (
                  match Event_history.decode_events body with
                  | Error message ->
                      inject_history (History_failed (session_id, message))
                  | Ok events ->
                      let buffer =
                        Event_buffer.create ~live_capacity:live_event_capacity
                          events
                      in
                      Effect.bind
                        (inject_history (Initial (session_id, events)))
                        ~f:(fun () ->
                          connect_stream ~selection ~session_id
                            ~after:(Event_buffer.highest_sequence buffer)
                            ~inject_history ~inject_deciding
                            ~refresh_catalog_effect ~refresh_snapshot_effect
                            ~set_stream_notice)))))

let component graph =
  let sessions, set_sessions = Bonsai.state Session_rail.Loading graph in
  let workspaces, set_workspaces = Bonsai.state [] graph in
  let selected_id, set_selected_id = Bonsai.state None graph in
  let mobile_open, set_mobile_open = Bonsai.state false graph in
  let collapsed, set_collapsed = Bonsai.state String.Set.empty graph in
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
  let copy_feedback, set_copy_feedback = Bonsai.state None graph in
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
  let refresh_runtime =
    let%arr selected_id = selected_id and inject_shell = inject_shell in
    Option.value_map selected_id ~default:Effect.Ignore ~f:(fun id ->
        load_snapshot ~inject_shell id)
  in
  let config_available =
    let%arr shell = shell in
    (not shell.runtime.loading) && Option.is_none shell.runtime.error
  in
  let config_controls =
    Config_controls.component runtime ~available:config_available
      ~refresh:refresh_runtime ~on_error:set_stream_notice graph
  in
  let composer =
    Composer.component selected stream_notice config_controls graph
  in
  let load =
    let%arr set_sessions = set_sessions
    and set_workspaces = set_workspaces
    and selected_id = selected_id
    and set_selected_id = set_selected_id
    and inject_history = inject_history
    and inject_deciding = inject_deciding
    and inject_shell = inject_shell
    and set_stream_notice = set_stream_notice in
    Effect.bind (Effect.of_deferred_thunk catalog_request) ~f:(fun response ->
        match decode_catalog response with
        | Error message -> set_sessions (Session_rail.Failed message)
        | Ok (next_workspaces, next_sessions) ->
            let next_id =
              Workspace_catalog.reconcile_selection ~previous:selected_id
                next_sessions
            in
            let catalog_refresh =
              refresh_catalog ~set_workspaces ~set_sessions
            in
            Effect.bind
              (Effect.Many
                 [
                   set_workspaces next_workspaces;
                   set_sessions (Session_rail.Loaded next_sessions);
                   set_selected_id next_id;
                 ])
              ~f:(fun () ->
                Option.value_map next_id ~default:Effect.Ignore ~f:(fun id ->
                    let snapshot_refresh = load_snapshot ~inject_shell id in
                    Effect.Many
                      [
                        snapshot_refresh;
                        load_history ~inject_history ~inject_deciding
                          ~refresh_catalog_effect:catalog_refresh
                          ~refresh_snapshot_effect:snapshot_refresh
                          ~set_stream_notice id;
                      ])))
  in
  let close_stream =
    let%arr () = Bonsai.return () in
    Effect.of_deferred_thunk (fun () ->
        Event_stream.close ();
        Async_kernel.Deferred.return ())
  in
  let activate =
    let%arr load = load and set_mobile_open = set_mobile_open in
    Effect.bind
      (Mobile_shell.start ~on_escape:(fun () -> set_mobile_open false))
      ~f:(fun () -> Effect.bind (Timeline_scroll.start ()) ~f:(fun () -> load))
  in
  let deactivate =
    let%arr close_stream = close_stream in
    Effect.Many
      [
        close_stream;
        Timeline_scroll.cleanup ();
        Clipboard.cleanup ();
        Mobile_shell.cleanup ();
      ]
  in
  Bonsai.Edge.lifecycle ~on_activate:activate ~on_deactivate:deactivate graph;
  let%arr sessions = sessions
  and workspaces = workspaces
  and selected_id = selected_id
  and mobile_open = mobile_open
  and collapsed = collapsed
  and shell = shell
  and runtime = runtime
  and history = history
  and deciding_permissions = deciding_permissions
  and composer = composer
  and copy_feedback = copy_feedback
  and set_selected_id = set_selected_id
  and set_mobile_open = set_mobile_open
  and set_collapsed = set_collapsed
  and inject_shell = inject_shell
  and inject_history = inject_history
  and inject_deciding = inject_deciding
  and set_stream_notice = set_stream_notice
  and set_copy_feedback = set_copy_feedback
  and set_sessions = set_sessions
  and set_workspaces = set_workspaces in
  let session = Session_rail.selected sessions selected_id in
  let workspace = selected_workspace workspaces session in
  let visible_history =
    match sessions with
    | Session_rail.Loading -> Timeline_view.Sessions_loading
    | Session_rail.Failed message -> Sessions_failed message
    | Session_rail.Loaded [] -> No_sessions
    | Session_rail.Loaded (_ :: _) -> history
  in
  let select id =
    let catalog_refresh = refresh_catalog ~set_workspaces ~set_sessions in
    let snapshot_refresh = load_snapshot ~inject_shell id in
    Effect.bind (Timeline_scroll.reset ()) ~f:(fun () ->
        Effect.bind (set_selected_id (Some id)) ~f:(fun () ->
            Effect.Many
              [
                composer.reset ();
                set_stream_notice "";
                set_mobile_open false;
                snapshot_refresh;
                load_history ~inject_history ~inject_deciding
                  ~refresh_catalog_effect:catalog_refresh
                  ~refresh_snapshot_effect:snapshot_refresh ~set_stream_notice
                  id;
              ]))
  in
  let close_mobile () =
    Effect.Many [ set_mobile_open false; Mobile_shell.focus_menu_button () ]
  in
  let open_mobile () =
    Effect.Many [ set_mobile_open true; Mobile_shell.focus_navigation () ]
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
  let decide ~request_id ~option_id =
    match session with
    | None -> Effect.Ignore
    | Some _ when Set.mem deciding_permissions request_id -> Effect.Ignore
    | Some session ->
        Effect.bind (inject_deciding (Add request_id)) ~f:(fun () ->
            Effect.bind
              (Effect.of_deferred_thunk (fun () ->
                   Browser_http.post_json
                     ~query:[ ("session", session.id) ]
                     "/api/v2/permissions"
                     (Permission_decision.to_yojson ~request_id ~option_id)))
              ~f:(function
                | Error error ->
                    Effect.Many
                      [
                        inject_deciding (Remove request_id);
                        composer.set_notice (Error.to_string_hum error);
                      ]
                | Ok _ ->
                    composer.set_notice
                      "Decision submitted. Waiting for the session event."))
  in
  let copy ~key ~text =
    Clipboard.copy ~key ~text ~on_change:set_copy_feedback
  in
  Vdom.Node.main ~attrs:(class_ "control-room")
    [
      render_header sessions workspaces selected_id runtime
        (Mobile_shell.menu_button ~open_:mobile_open ~on_open:open_mobile);
      Vdom.Node.section ~attrs:(class_ "workspace-grid")
        [
          Mobile_shell.scrim ~open_:mobile_open ~on_close:close_mobile;
          Session_rail.render sessions ~workspaces ~selected_id ~collapsed
            ~mobile_open ~on_toggle:toggle_workspace ~on_select:select;
          Timeline_view.render ~session ~workspace ~runtime
            ~runtime_loading:shell.runtime.loading
            ~runtime_error:shell.runtime.error ~tab:shell.tab ~on_tab:select_tab
            ~state:visible_history
            ~composer:(Option.map session ~f:(fun _ -> composer.view))
            ~deciding_permissions ~copy_feedback ~on_copy:copy
            ~on_permission:decide;
        ];
    ]

let () = Bonsai_web.Start.start component
