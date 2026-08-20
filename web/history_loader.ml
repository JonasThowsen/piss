open! Core
open! Bonsai_web.Cont
open App_state

type cached_history = {
  events : Event_history.event Int64.Map.t;
  complete : bool;
  touched : int;
}

let warm_session_capacity = 4
let warm_event_capacity = live_event_capacity
let cache_clock = ref 0
let load_generation = ref 0
let history_request_clock = ref 0
let warm_histories = ref String.Map.empty
let active_recovery : (string * int) option ref = ref None
let active_history_request : (int * int * (unit -> unit)) option ref = ref None

let cancel_active_history_request () =
  Option.iter !active_history_request ~f:(fun (_, _, cancel) -> cancel ());
  active_history_request := None

let next_load_generation () =
  cancel_active_history_request ();
  active_recovery := None;
  Int.incr load_generation;
  !load_generation

let current_load generation = generation = !load_generation

let next_touch () =
  Int.incr cache_clock;
  !cache_clock

let index_events events =
  List.fold events ~init:Int64.Map.empty ~f:(fun by_sequence event ->
      Map.set by_sequence ~key:(Event_history.sequence event) ~data:event)

let trim_warm_histories histories =
  if Map.length histories <= warm_session_capacity then histories
  else
    match
      Map.to_alist histories
      |> List.min_elt ~compare:(fun (_, left) (_, right) ->
          Int.compare left.touched right.touched)
    with
    | None -> histories
    | Some (session_id, _) -> Map.remove histories session_id

let bound_events events =
  let rec trim events =
    if Map.length events <= warm_event_capacity then events
    else
      match Map.min_elt events with
      | None -> events
      | Some (sequence, _) -> trim (Map.remove events sequence)
  in
  trim events

let store_history session_id ~events ~complete =
  warm_histories :=
    Map.set !warm_histories ~key:session_id
      ~data:{ events = bound_events events; complete; touched = next_touch () }
    |> trim_warm_histories

let remember_history session_id events =
  let complete = Event_history.initial_history_is_complete events in
  store_history session_id ~events:(index_events events) ~complete

let may_complete_history event =
  List.mem
    [ "command.accepted"; "command.state"; "command.recovered" ]
    (Event_history.kind event) ~equal:String.equal

let merge_history session_id additions =
  let cached = Map.find !warm_histories session_id in
  let existing =
    Option.value_map cached ~default:Int64.Map.empty ~f:(fun cached ->
        cached.events)
  in
  let unbounded =
    List.fold additions ~init:existing ~f:(fun events event ->
        Map.set events ~key:(Event_history.sequence event) ~data:event)
  in
  let trimmed = Map.length unbounded > warm_event_capacity in
  let events = bound_events unbounded in
  let completeness_may_change =
    trimmed || List.exists additions ~f:may_complete_history
  in
  let complete =
    if completeness_may_change then
      Event_history.initial_history_is_complete (Map.data events)
    else Option.exists cached ~f:(fun cached -> cached.complete)
  in
  store_history session_id ~events ~complete;
  not trimmed

let cached_history session_id =
  match Map.find !warm_histories session_id with
  | None -> None
  | Some cached ->
      let cached = { cached with touched = next_touch () } in
      warm_histories := Map.set !warm_histories ~key:session_id ~data:cached;
      Some (Map.data cached.events, cached.complete)

let mark_history_exhausted session_id =
  warm_histories :=
    Map.change !warm_histories session_id ~f:(function
      | None -> None
      | Some cached -> Some { cached with complete = true })

let refresh_history_completeness session_id =
  warm_histories :=
    Map.change !warm_histories session_id ~f:(function
      | None -> None
      | Some cached ->
          Some
            {
              cached with
              complete =
                Event_history.initial_history_is_complete
                  (Map.data cached.events);
            })

let cancellable_history_get generation query =
  cancel_active_history_request ();
  Int.incr history_request_clock;
  let request_id = !history_request_clock in
  let response, cancel = Browser_http.get_cancelable ~query "/api/v2/events" in
  if current_load generation then
    active_history_request := Some (generation, request_id, cancel)
  else cancel ();
  Async_kernel.Deferred.map response ~f:(fun response ->
      (match !active_history_request with
      | Some (active_generation, active_request, _)
        when active_generation = generation && active_request = request_id ->
          active_history_request := None
      | None | Some _ -> ());
      response)

let history_request ~generation session_id =
  cancellable_history_get generation
    [ ("recent", "500"); ("session", session_id) ]

let older_request ~generation ~limit ~session_id ~before =
  cancellable_history_get generation
    [
      ("before", Int64.to_string before);
      ("limit", Int.to_string limit);
      ("session", session_id);
    ]

let rec extend_initial_history ~generation ~session_id events =
  if not (current_load generation) then
    Async_kernel.Deferred.return (Error "history load superseded")
  else if Event_history.initial_history_is_complete events then
    Async_kernel.Deferred.return (Ok events)
  else
    match List.hd events with
    | None -> Async_kernel.Deferred.return (Ok events)
    | Some earliest -> (
        let open Async_kernel.Deferred.Let_syntax in
        let%bind response =
          older_request ~generation ~limit:500 ~session_id
            ~before:(Event_history.sequence earliest)
        in
        match response with
        | Error error ->
            Async_kernel.Deferred.return (Error (Error.to_string_hum error))
        | Ok body -> (
            match Event_history.decode_events body with
            | Error message -> Async_kernel.Deferred.return (Error message)
            | Ok [] ->
                if Event_history.has_unresolved_recoveries events then
                  Async_kernel.Deferred.return
                    (Error "recovered command acceptance is unavailable")
                else Async_kernel.Deferred.return (Ok events)
            | Ok (page_earliest :: _ as page) ->
                if
                  Int64.(
                    Event_history.sequence page_earliest
                    >= Event_history.sequence earliest)
                then
                  Async_kernel.Deferred.return
                    (Error "older history page did not advance")
                else
                  extend_initial_history ~generation ~session_id (page @ events)
            ))

let initial_history_request ~generation session_id =
  let open Async_kernel.Deferred.Let_syntax in
  let%bind response = history_request ~generation session_id in
  match response with
  | Error error ->
      Async_kernel.Deferred.return (Error (Error.to_string_hum error))
  | Ok body -> Async_kernel.Deferred.return (Event_history.decode_events body)

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
        ignore (merge_history session_id [ event ]);
        let append =
          Effect.bind
            (inject_history (Append (session_id, event)))
            ~f:(fun () -> Timeline_scroll.resume ())
        in
        let effects =
          [ append ]
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

let is_recovering session_id =
  Option.exists !active_recovery ~f:(fun (active_session, generation) ->
      String.equal active_session session_id && current_load generation)

let reserve_initial_recovery session_id ~generation ~complete =
  if complete || not (current_load generation) then false
  else (
    active_recovery := Some (session_id, generation);
    true)

let finish_recovery session_id generation =
  if
    Option.exists !active_recovery
      ~f:(fun (active_session, active_generation) ->
        String.equal active_session session_id && active_generation = generation)
  then active_recovery := None

let recover_initial_history ~inject_history ~session_id ~generation ~reserved
    events =
  if (not reserved) || not (current_load generation) then Effect.Ignore
  else
    Effect.bind
      (Effect.of_deferred_thunk (fun () ->
           extend_initial_history ~generation ~session_id events))
      ~f:(fun result ->
        finish_recovery session_id generation;
        if not (current_load generation) then Effect.Ignore
        else
          match result with
          | Error message -> inject_history (Older_failed (session_id, message))
          | Ok events ->
              let untrimmed = merge_history session_id events in
              if untrimmed then mark_history_exhausted session_id
              else refresh_history_completeness session_id;
              Timeline_scroll.preserve_after_prepend
                (inject_history (Prepend_older (session_id, events))))

let load_initial ~inject_history ~inject_deciding ~refresh_catalog_effect
    ~refresh_snapshot_effect ~set_stream_notice session_id =
  let generation = next_load_generation () in
  let selection = Event_stream.select ~session_id in
  let activate events =
    let buffer =
      Event_buffer.create ~live_capacity:live_event_capacity events
    in
    if not (current_load generation) then Effect.Ignore
    else
      Effect.bind
        (inject_history (Initial (session_id, events)))
        ~f:(fun () ->
          if not (current_load generation) then Effect.Ignore
          else
            Effect.bind (Timeline_scroll.reset ()) ~f:(fun () ->
                if not (current_load generation) then Effect.Ignore
                else
                  connect_stream ~selection ~session_id
                    ~after:(Event_buffer.highest_sequence buffer)
                    ~inject_history ~inject_deciding ~refresh_catalog_effect
                    ~refresh_snapshot_effect ~set_stream_notice))
  in
  Effect.bind (inject_deciding Reset) ~f:(fun () ->
      Effect.bind (inject_history (Start session_id)) ~f:(fun () ->
          if not (current_load generation) then Effect.Ignore
          else
            match cached_history session_id with
            | Some (events, complete) ->
                let reserved =
                  reserve_initial_recovery session_id ~generation ~complete
                in
                Effect.bind (activate events) ~f:(fun () ->
                    recover_initial_history ~inject_history ~session_id
                      ~generation ~reserved events)
            | None ->
                Effect.bind
                  (Effect.of_deferred_thunk (fun () ->
                       initial_history_request ~generation session_id))
                  ~f:(fun result ->
                    if not (current_load generation) then Effect.Ignore
                    else
                      match result with
                      | Error message ->
                          inject_history (History_failed (session_id, message))
                      | Ok events ->
                          remember_history session_id events;
                          let reserved =
                            reserve_initial_recovery session_id ~generation
                              ~complete:
                                (Event_history.initial_history_is_complete
                                   events)
                          in
                          Effect.bind (activate events) ~f:(fun () ->
                              recover_initial_history ~inject_history
                                ~session_id ~generation ~reserved events))))

let load_older ~inject_history ~set_stream_notice ~session_id ~before =
  let generation = !load_generation in
  Effect.bind (inject_history (Begin_older session_id)) ~f:(fun () ->
      Effect.bind
        (Effect.of_deferred_thunk (fun () ->
             older_request ~generation ~limit:200 ~session_id ~before))
        ~f:(fun response ->
          if not (current_load generation) then Effect.Ignore
          else
            match response with
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
                    ignore (merge_history session_id events);
                    Timeline_scroll.preserve_after_prepend
                      (inject_history (Prepend_older (session_id, events))))))
