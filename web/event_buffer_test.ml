open! Core

let fail message = raise_s [%message message]

let event sequence kind =
  let body =
    Printf.sprintf
      {|{"sequence":%d,"kind":"%s","payload":{},"createdAt":1723123456}|}
      sequence kind
  in
  match Event_history.decode_event body with
  | Ok event -> event
  | Error message -> fail message

let command_event ?(action = "prompt") sequence =
  let body =
    Printf.sprintf
      {|{"sequence":%d,"kind":"command.accepted","payload":{"commandId":"command-%d","requestId":"request-%d","action":"%s","text":"run-%d","imageCount":0,"images":[],"resourceCount":0,"resources":[]},"createdAt":1723123456}|}
      sequence sequence sequence action sequence
  in
  match Event_history.decode_event body with
  | Ok event -> event
  | Error message -> fail message

let command_state_event sequence command_sequence state =
  let body =
    Printf.sprintf
      {|{"sequence":%d,"kind":"command.state","payload":{"commandId":"command-%d","state":"%s"},"createdAt":1723123456}|}
      sequence command_sequence state
  in
  match Event_history.decode_event body with
  | Ok event -> event
  | Error message -> fail message

let sequences buffer =
  Event_buffer.events buffer
  |> List.map ~f:(fun event -> Event_history.sequence event |> Int64.to_int_exn)

let full_outbox buffer =
  Event_buffer.events buffer
  |> List.filter_map ~f:Event_history.outbox_update
  |> Outbox_projection.project

let () =
  let initial = [ event 10 "fixture.initial"; event 20 "fixture.initial" ] in
  let buffer = Event_buffer.create ~live_capacity:2 initial in
  let buffer = Event_buffer.add buffer (event 30 "fixture.live") in
  if Event_buffer.projection_rebuilds buffer <> 1 then
    fail "ordered live append rebuilt retained projection";
  let duplicate = Event_buffer.add buffer (event 30 "fixture.duplicate") in
  if Event_buffer.live_length duplicate <> 1 then fail "duplicate was retained";
  let buffer = Event_buffer.add duplicate (event 25 "fixture.live") in
  if Event_buffer.projection_rebuilds buffer <> 2 then
    fail "out-of-order live append did not rebuild projection";
  let buffer = Event_buffer.add buffer (event 40 "fixture.live") in
  if Event_buffer.projection_rebuilds buffer <> 3 then
    fail "live-cap eviction did not rebuild projection";
  if Event_buffer.history_length buffer <> 2 then
    fail "live cap removed initial history";
  if Event_buffer.live_length buffer <> 2 then fail "live cap was not enforced";
  if not (List.equal Int.equal (sequences buffer) [ 10; 20; 30; 40 ]) then
    fail "events were not deduplicated and ordered";
  if not (Int64.equal (Event_buffer.highest_sequence buffer) 40L) then
    fail "highest sequence was incorrect";
  let paged =
    Event_buffer.create ~live_capacity:4
      [ event 10 "fixture.initial"; event 20 "fixture.initial" ]
    |> Fn.flip Event_buffer.add (event 30 "fixture.live")
    |> Event_buffer.begin_page
    |> Fn.flip Event_buffer.add (event 25 "fixture.concurrent-live")
  in
  let paged =
    match
      Event_buffer.prepend paged
        [ event 1 "fixture.older"; event 5 "fixture.older"; event 10 "overlap" ]
    with
    | Ok value -> value
    | Error message -> fail message
  in
  if not (List.equal Int.equal (sequences paged) [ 1; 5; 10; 20; 25; 30 ]) then
    fail "prepend lost, duplicated, or misordered concurrent live events";
  if Event_buffer.live_length paged <> 2 then
    fail "prepend changed the live-event map";
  if not (Event_buffer.can_page_before paged ~first_sequence:0L) then
    fail "retained lower bound stopped paging too early";
  (match Event_buffer.prepend paged [ event 4 "bad"; event 3 "bad" ] with
  | Error message when String.is_substring message ~substring:"increasing" -> ()
  | _ -> fail "out-of-order prepend page was accepted");
  let stopped =
    match Event_buffer.prepend paged [] with
    | Ok value -> value
    | Error message -> fail message
  in
  if Event_buffer.can_page_before stopped ~first_sequence:1L then
    fail "empty server page did not stop paging";
  let capped =
    Event_buffer.create ~live_capacity:4 [ event 10 "fixture.initial" ]
    |> Event_buffer.begin_page
    |> fun buffer ->
    match Event_buffer.prepend buffer [ event 5 "fixture.recovered" ] with
    | Error message -> fail message
    | Ok buffer -> Event_buffer.fail_page buffer "recovery capped"
  in
  if not (List.equal Int.equal (sequences capped) [ 5; 10 ]) then
    fail "capped recovery discarded accumulated pages";
  if not (Event_buffer.can_page_before capped ~first_sequence:1L) then
    fail "capped recovery disabled manual paging";
  (match Event_buffer.page_error capped with
  | Some "recovery capped" -> ()
  | _ -> fail "capped recovery notice was not retained");
  let streamed =
    List.range 1 1_001
    |> List.fold ~init:(Event_buffer.create ~live_capacity:1_001 [])
         ~f:(fun buffer sequence ->
           Event_buffer.add buffer (command_event sequence))
  in
  if Event_buffer.projection_rebuilds streamed <> 1 then
    fail "ordered stream repeatedly rebuilt retained projection";
  if
    not
      (Poly.equal
         (Event_buffer.entries streamed)
         (Event_history.project (Event_buffer.events streamed)))
  then fail "incremental projection diverged from full projection";
  let sustained =
    List.range 1 5_001
    |> List.fold ~init:(Event_buffer.create ~live_capacity:4_096 [])
         ~f:(fun buffer sequence ->
           Event_buffer.add buffer (event sequence "fixture.sustained"))
  in
  if Event_buffer.live_length sustained > 4_096 then
    fail "batched live eviction exceeded capacity";
  if Event_buffer.projection_rebuilds sustained > 6 then
    fail "post-capacity stream rebuilt projection for every eviction";
  let outbox =
    Event_buffer.create ~live_capacity:16 []
    |> Fn.flip Event_buffer.add (command_event ~action:"steer" 1)
    |> Fn.flip Event_buffer.add (command_event ~action:"follow_up" 2)
    |> Fn.flip Event_buffer.add (command_state_event 3 1 "ambiguous")
    |> Fn.flip Event_buffer.add (command_state_event 4 2 "completed")
  in
  if not (Poly.equal (Event_buffer.outbox outbox) (full_outbox outbox)) then
    fail "incremental outbox diverged from full projection"
