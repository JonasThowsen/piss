open! Core
open! Bonsai_web.Cont
open App_state

let history_request session_id =
  Browser_http.get
    ~query:[ ("recent", "500"); ("session", session_id) ]
    "/api/v2/events"

let older_request ~session_id ~before =
  Browser_http.get
    ~query:
      [
        ("before", Int64.to_string before);
        ("limit", "200");
        ("session", session_id);
      ]
    "/api/v2/events"

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
  let on_open () =
    dispatch
      (Effect.Many
         [
           set_stream_notice ""; refresh_catalog_effect; refresh_snapshot_effect;
         ])
  in
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

let load_initial ~inject_history ~inject_deciding ~refresh_catalog_effect
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

let load_older ~inject_history ~set_stream_notice ~session_id ~before =
  Effect.bind (inject_history (Begin_older session_id)) ~f:(fun () ->
      Effect.bind
        (Effect.of_deferred_thunk (fun () -> older_request ~session_id ~before))
        ~f:(function
          | Error error ->
              let message = Error.to_string_hum error in
              Effect.Many
                [
                  inject_history (Older_failed (session_id, message));
                  set_stream_notice message;
                ]
          | Ok body -> (
              match Event_history.decode_events body with
              | Error message ->
                  Effect.Many
                    [
                      inject_history (Older_failed (session_id, message));
                      set_stream_notice message;
                    ]
              | Ok events ->
                  Timeline_scroll.preserve_after_prepend
                    (inject_history (Prepend_older (session_id, events))))))
