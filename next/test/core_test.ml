open Piss_core

let with_store f =
  let path = Filename.temp_file "piss-worker-" ".sqlite3" in
  Fun.protect
    ~finally:(fun () ->
      List.iter
        (fun suffix ->
          let candidate = path ^ suffix in
          if Sys.file_exists candidate then Sys.remove candidate)
        [ ""; "-wal"; "-shm" ])
    (fun () ->
      let store =
        Store.open_ ~path ~session_id:(Domain.Session_id "session")
          ~worker_id:(Domain.Worker_id "worker")
      in
      Fun.protect ~finally:(fun () -> Store.close store) (fun () -> f store))

let test_command_deduplication () =
  with_store @@ fun store ->
  let first =
    Store.accept_command store ~command_id:"command-1" ~request_id:"command-1"
      ~prompt:"do the thing"
  in
  let duplicate =
    Store.accept_command store ~command_id:"command-1" ~request_id:"command-1"
      ~prompt:"this must never replace the accepted prompt"
  in
  Alcotest.(check bool) "first delivery is new" false first.duplicate;
  Alcotest.(check bool) "second delivery is duplicate" true duplicate.duplicate;
  Alcotest.(check string)
    "durable state is returned" "accepted"
    (Domain.command_state_to_string duplicate.state)

let test_event_retention_compacts () =
  with_store @@ fun store ->
  Store.transaction store (fun () ->
      for index = 1 to Store.max_retained_events + 1 do
        ignore
          (Store.append_event store
             ~kind:("event-" ^ string_of_int index)
             `Null)
      done);
  let count = Store.row_count store "events" |> Int64.to_int in
  Alcotest.(check bool)
    "bounded" true
    (count <= Store.max_retained_events && count > 0);
  let recent = Store.list_recent_events store ~limit:1 in
  Alcotest.(check string)
    "newest retained"
    ("event-" ^ string_of_int (Store.max_retained_events + 1))
    (List.hd recent).kind

let test_restart_reconciliation () =
  let path = Filename.temp_file "piss-reconcile-" ".sqlite3" in
  Fun.protect
    ~finally:(fun () ->
      List.iter
        (fun suffix ->
          let candidate = path ^ suffix in
          if Sys.file_exists candidate then Sys.remove candidate)
        [ ""; "-wal"; "-shm" ])
    (fun () ->
      let open_store () =
        Store.open_ ~path ~session_id:(Domain.Session_id "session")
          ~worker_id:(Domain.Worker_id "worker")
      in
      let first = open_store () in
      ignore
        (Store.accept_command first ~command_id:"interrupted"
           ~request_id:"interrupted" ~prompt:"perform a consequential action");
      Store.set_command_state first ~command_id:"interrupted" Domain.Dispatched;
      Store.close first;
      let replacement = open_store () in
      Fun.protect ~finally:(fun () -> Store.close replacement) @@ fun () ->
      let reconciled = Store.reconcile_incomplete_commands replacement in
      Alcotest.(check (list string))
        "reconciled identity" [ "interrupted" ] reconciled;
      match Store.find_command replacement "interrupted" with
      | Some Domain.Ambiguous -> ()
      | Some state ->
          Alcotest.failf "expected ambiguous, got %s"
            (Domain.command_state_to_string state)
      | None -> Alcotest.fail "reconciled command disappeared")

let test_event_sequence () =
  with_store @@ fun store ->
  let first = Store.append_event store ~kind:"first" (`String "one") in
  let second = Store.append_event store ~kind:"second" (`String "two") in
  Alcotest.(check int64)
    "monotonic"
    Int64.(add first.sequence 1L)
    second.sequence;
  let replay = Store.list_events store ~after:first.sequence ~limit:10 in
  Alcotest.(check int) "exclusive cursor" 1 (List.length replay);
  Alcotest.(check string) "right event" "second" (List.hd replay).kind;
  let recent = Store.list_recent_events store ~limit:1 in
  Alcotest.(check int) "recent page size" 1 (List.length recent);
  Alcotest.(check string) "recent event" "second" (List.hd recent).kind

let test_wire_bounds () =
  let decode json = Wire.request_of_yojson (Yojson.Safe.from_string json) in
  (match decode {|{"op":"events","after":0,"limit":501}|} with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "oversized event page was accepted");
  (match decode {|{"op":"unknown"}|} with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "unknown worker operation was accepted");
  let oversized = String.make ((64 * 1024) + 1) 'x' in
  let prompt =
    `Assoc
      [
        ("op", `String "prompt");
        ("commandId", `String "bounded");
        ("text", `String oversized);
      ]
  in
  match Wire.request_of_yojson prompt with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "oversized prompt was accepted"

let test_acp_error_response () =
  let response =
    `Assoc
      [
        ("jsonrpc", `String "2.0");
        ("id", `String "session-new");
        ( "error",
          `Assoc
            [
              ("code", `Int (-32603));
              ("message", `String "adapter could not create its state directory");
            ] );
      ]
  in
  match Acp.response_result ~expected_id:"session-new" response with
  | Error message ->
      Alcotest.(check string)
        "message is retained"
        "ACP request session-new failed: adapter could not create its state \
         directory"
        message
  | Ok _ -> Alcotest.fail "ACP error response was accepted as success"

let test_stable_state_decoding () =
  List.iter
    (fun state ->
      let encoded = Domain.command_state_to_string state in
      match Domain.command_state_of_string encoded with
      | Ok decoded ->
          Alcotest.(check string)
            encoded encoded
            (Domain.command_state_to_string decoded)
      | Error message -> Alcotest.fail message)
    Domain.
      [
        Received;
        Accepted;
        Dispatched;
        Acknowledged;
        Completed;
        Cancelled;
        Ambiguous;
        Rejected;
      ]

let () =
  Alcotest.run "piss-next"
    [
      ( "durability",
        [
          Alcotest.test_case "command deduplication" `Quick
            test_command_deduplication;
          Alcotest.test_case "event sequence" `Quick test_event_sequence;
          Alcotest.test_case "event retention compacts" `Quick
            test_event_retention_compacts;
          Alcotest.test_case "restart reconciliation" `Quick
            test_restart_reconciliation;
        ] );
      ( "domain",
        [
          Alcotest.test_case "command states round trip" `Quick
            test_stable_state_decoding;
          Alcotest.test_case "wire bounds fail closed" `Quick test_wire_bounds;
          Alcotest.test_case "ACP errors fail closed" `Quick
            test_acp_error_response;
        ] );
    ]
