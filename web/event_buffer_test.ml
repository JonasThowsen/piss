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
    fail "highest sequence was incorrect"
