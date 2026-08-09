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

let selected_session state selected_id =
  match (state, selected_id) with
  | Session_rail.Loaded sessions, Some id ->
      List.find sessions ~f:(fun (session : Control_plane.Session.t) ->
          String.equal session.id id)
  | _ -> None

let render_header sessions selected_id =
  let status, status_class =
    match (sessions, selected_session sessions selected_id) with
    | Session_rail.Loading, _ -> ("loading", "running")
    | Failed _, _ -> ("offline", "offline")
    | Loaded [], _ -> ("idle", "idle")
    | Loaded _, Some session ->
        let status = Control_plane.Session.status_to_string session.status in
        (status, status)
    | Loaded _, None -> ("idle", "idle")
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

let history_request session_id =
  Browser_http.get
    ~query:[ ("recent", "500"); ("session", session_id) ]
    "/api/v2/events"

let refresh_sessions ~set_sessions =
  Effect.bind
    (Effect.of_deferred_thunk (fun () -> Browser_http.get "/api/v2/sessions"))
    ~f:(function
      | Error _ -> Effect.Ignore
      | Ok body -> (
          match Control_plane.decode_sessions body with
          | Error _ -> Effect.Ignore
          | Ok sessions -> set_sessions (Session_rail.Loaded sessions)))

let terminal_permission event =
  match Event_history.project [ event ] with
  | [ Event_history.Permission_resolved { request_id; _ } ]
  | [ Permission_cancelled { request_id; _ } ] ->
      Some request_id
  | _ -> None

let dispatch action = Vdom.Effect.Expert.handle_non_dom_event_exn action

let connect_stream ~selection ~session_id ~after ~inject_history
    ~inject_deciding ~set_sessions ~set_stream_notice =
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
            [ refresh_sessions ~set_sessions ]
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

let load_history ~inject_history ~inject_deciding ~set_sessions
    ~set_stream_notice session_id =
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
                            ~inject_history ~inject_deciding ~set_sessions
                            ~set_stream_notice)))))

let component graph =
  let sessions, set_sessions = Bonsai.state Session_rail.Loading graph in
  let selected_id, set_selected_id = Bonsai.state None graph in
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
    selected_session sessions selected_id
  in
  let composer = Composer.component selected stream_notice graph in
  let load =
    let%arr set_sessions = set_sessions
    and set_selected_id = set_selected_id
    and inject_history = inject_history
    and inject_deciding = inject_deciding
    and set_stream_notice = set_stream_notice in
    Effect.bind
      (Effect.of_deferred_thunk (fun () -> Browser_http.get "/api/v2/sessions"))
      ~f:(function
        | Error error -> set_sessions (Failed (Error.to_string_hum error))
        | Ok body -> (
            match Control_plane.decode_sessions body with
            | Error message -> set_sessions (Failed message)
            | Ok sessions ->
                Effect.bind (set_sessions (Loaded sessions)) ~f:(fun () ->
                    match sessions with
                    | [] -> Effect.Ignore
                    | session :: _ ->
                        Effect.bind (set_selected_id (Some session.id))
                          ~f:(fun () ->
                            load_history ~inject_history ~inject_deciding
                              ~set_sessions ~set_stream_notice session.id))))
  in
  let close_stream =
    let%arr () = Bonsai.return () in
    Effect.of_deferred_thunk (fun () ->
        Event_stream.close ();
        Async_kernel.Deferred.return ())
  in
  let activate =
    let%arr load = load in
    Effect.bind (Timeline_scroll.start ()) ~f:(fun () -> load)
  in
  let deactivate =
    let%arr close_stream = close_stream in
    Effect.Many
      [ close_stream; Timeline_scroll.cleanup (); Clipboard.cleanup () ]
  in
  Bonsai.Edge.lifecycle ~on_activate:activate ~on_deactivate:deactivate graph;
  let%arr sessions = sessions
  and selected_id = selected_id
  and history = history
  and deciding_permissions = deciding_permissions
  and composer = composer
  and copy_feedback = copy_feedback
  and set_selected_id = set_selected_id
  and inject_history = inject_history
  and inject_deciding = inject_deciding
  and set_stream_notice = set_stream_notice
  and set_copy_feedback = set_copy_feedback
  and set_sessions = set_sessions in
  let session = selected_session sessions selected_id in
  let visible_history =
    match sessions with
    | Session_rail.Loading -> Timeline_view.Sessions_loading
    | Failed message -> Sessions_failed message
    | Loaded [] -> No_sessions
    | Loaded (_ :: _) -> history
  in
  let select id =
    Effect.bind (Timeline_scroll.reset ()) ~f:(fun () ->
        Effect.bind (set_selected_id (Some id)) ~f:(fun () ->
            Effect.Many
              [
                composer.reset ();
                set_stream_notice "";
                load_history ~inject_history ~inject_deciding ~set_sessions
                  ~set_stream_notice id;
              ]))
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
      render_header sessions selected_id;
      Vdom.Node.section ~attrs:(class_ "workspace-grid")
        [
          Session_rail.render sessions ~selected_id ~on_select:select;
          Timeline_view.render ~session ~state:visible_history
            ~composer:(Option.map session ~f:(fun _ -> composer.view))
            ~deciding_permissions ~copy_feedback ~on_copy:copy
            ~on_permission:decide;
        ];
    ]

let () = Bonsai_web.Start.start component
