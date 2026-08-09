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

let sequences buffer =
  Event_buffer.events buffer
  |> List.map ~f:(fun event -> Event_history.sequence event |> Int64.to_int_exn)

let () =
  let initial = [ event 10 "fixture.initial"; event 20 "fixture.initial" ] in
  let buffer = Event_buffer.create ~live_capacity:2 initial in
  let buffer = Event_buffer.add buffer (event 30 "fixture.live") in
  let duplicate = Event_buffer.add buffer (event 30 "fixture.duplicate") in
  if Event_buffer.live_length duplicate <> 1 then fail "duplicate was retained";
  let buffer = Event_buffer.add duplicate (event 25 "fixture.live") in
  let buffer = Event_buffer.add buffer (event 40 "fixture.live") in
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
    fail "empty server page did not stop paging"
