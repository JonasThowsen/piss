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

let with_registry f =
  let path = Filename.temp_file "piss-registry-" ".sqlite3" in
  Fun.protect
    ~finally:(fun () ->
      List.iter
        (fun suffix ->
          let candidate = path ^ suffix in
          if Sys.file_exists candidate then Sys.remove candidate)
        [ ""; "-wal"; "-shm" ])
    (fun () ->
      let registry = Registry.open_ ~path in
      Fun.protect
        ~finally:(fun () -> Registry.close registry)
        (fun () -> f registry))

let test_session_registry () =
  with_registry @@ fun registry ->
  Registry.upsert_workspace registry ~id:"workspace-one" ~name:"Workspace one"
    ~root:"/tmp/workspace-one";
  Alcotest.(check int)
    "one workspace" 1
    (List.length (Registry.list_workspaces registry));
  Alcotest.(check (option string))
    "workspace can be recovered by canonical root" (Some "workspace-one")
    (Registry.find_workspace_by_root registry "/tmp/workspace-one"
    |> Option.map (fun (workspace : Registry.workspace) -> workspace.id));
  ignore
    (Registry.insert registry ~id:"s-one" ~title:"Pi / one" ~harness:"pi"
       ~workspace_id:"workspace-one");
  ignore
    (Registry.insert registry ~id:"s-two" ~title:"OpenCode / two"
       ~harness:"opencode" ~workspace_id:"workspace-one");
  Alcotest.(check int) "two active sessions" 2 (Registry.active_count registry);
  Alcotest.(check bool)
    "archive changes state" true
    (Registry.archive registry "s-one");
  Alcotest.(check int) "one active session" 1 (Registry.active_count registry);
  Alcotest.(check bool)
    "archived session hidden" true
    (Option.is_none (Registry.find_active registry "s-one"));
  Alcotest.(check int)
    "durable archived row retained" 2
    (List.length (Registry.list registry ~include_archived:true));
  Alcotest.(check int)
    "one archived session" 1
    (List.length (Registry.list_archived registry));
  Alcotest.(check bool)
    "last active session can be archived" true
    (Registry.archive registry "s-two");
  Alcotest.(check int) "no active sessions" 0 (Registry.active_count registry);
  Alcotest.(check bool)
    "first restore changes state" true
    (Registry.restore registry "s-one");
  Alcotest.(check bool)
    "second restore changes state" true
    (Registry.restore registry "s-two");
  Alcotest.(check int) "two active again" 2 (Registry.active_count registry);
  Alcotest.(check bool)
    "rename changes title" true
    (Registry.rename_session registry "s-one" "Orchestrator");
  let one = Option.get (Registry.find_active registry "s-one") in
  let two = Option.get (Registry.find_active registry "s-two") in
  Alcotest.(check string) "renamed title retained" "Orchestrator" one.title;
  Alcotest.(check string) "workspace retained" "workspace-one" one.workspace_id;
  Alcotest.(check bool)
    "broker tokens are unique" true
    (one.broker_token <> "" && two.broker_token <> ""
    && one.broker_token <> two.broker_token);
  Alcotest.(check string)
    "token identifies active session" "s-one"
    (Option.get (Registry.find_active_by_token registry one.broker_token)).id;
  let request, duplicate =
    Registry.accept_peer_request registry ~id:"peer-one" ~source_id:one.id
      ~target_id:two.id ~prompt:"review this" ~command_id:"peer-command"
      ~start_sequence:7L
  in
  Alcotest.(check bool) "first peer request is new" false duplicate;
  Alcotest.(check int64) "peer cursor retained" 7L request.start_sequence;
  let _, duplicate =
    Registry.accept_peer_request registry ~id:"peer-one" ~source_id:one.id
      ~target_id:two.id ~prompt:"review this" ~command_id:"peer-command"
      ~start_sequence:99L
  in
  Alcotest.(check bool) "peer request deduplicates" true duplicate;
  Registry.mark_peer_dispatching registry "peer-one" ~start_sequence:8L;
  let dispatching =
    Option.get (Registry.find_peer_request registry "peer-one")
  in
  Alcotest.(check string)
    "peer request dispatching" "dispatching" dispatching.state;
  Alcotest.(check int64) "dispatch cursor updated" 8L dispatching.start_sequence;
  Alcotest.(check bool)
    "first completion changes state" true
    (Registry.complete_peer_request registry "peer-one" "reviewed");
  Alcotest.(check bool)
    "completion deduplicates" false
    (Registry.complete_peer_request registry "peer-one" "must not replace");
  Alcotest.(check int)
    "source request listing" 1
    (List.length (Registry.list_peer_requests registry ~source_id:one.id));
  let completed = Option.get (Registry.find_peer_request registry "peer-one") in
  Alcotest.(check string)
    "peer response retained" "reviewed"
    (Option.get completed.response);
  let subscription, duplicate =
    Registry.accept_peer_subscription registry ~id:"wake-one" ~source_id:one.id
      ~request_ids:[ "peer-one" ] ~wait_for:"all"
      ~command_id:"peer-wake-command"
  in
  Alcotest.(check bool) "first wake subscription is new" false duplicate;
  Alcotest.(check string)
    "wake subscription pending" "pending" subscription.state;
  let _, duplicate =
    Registry.accept_peer_subscription registry ~id:"wake-one" ~source_id:one.id
      ~request_ids:[ "peer-one" ] ~wait_for:"all"
      ~command_id:"peer-wake-command"
  in
  Alcotest.(check bool) "wake subscription deduplicates" true duplicate;
  Registry.mark_peer_subscription_dispatching registry "wake-one";
  Alcotest.(check string)
    "wake subscription dispatching" "dispatching"
    (Option.get (Registry.find_peer_subscription registry "wake-one")).state;
  Alcotest.(check int)
    "open wake subscription listed" 1
    (List.length (Registry.list_open_peer_subscriptions registry));
  Alcotest.(check bool)
    "wake delivery changes state" true
    (Registry.complete_peer_subscription registry "wake-one");
  Alcotest.(check bool)
    "wake delivery deduplicates" false
    (Registry.complete_peer_subscription registry "wake-one");
  Alcotest.(check int)
    "delivered wake no longer open" 0
    (List.length (Registry.list_open_peer_subscriptions registry))

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
  Alcotest.(check string) "recent event" "second" (List.hd recent).kind;
  let older =
    Store.list_events_before store ~before:second.sequence ~limit:10
  in
  Alcotest.(check int) "older page size" 1 (List.length older);
  Alcotest.(check string)
    "older page remains ascending" "first" (List.hd older).kind

let test_wire_bounds () =
  let decode json = Wire.request_of_yojson (Yojson.Safe.from_string json) in
  (match decode {|{"op":"events","after":0,"limit":501}|} with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "oversized event page was accepted");
  (match decode {|{"op":"events_before","before":0,"limit":200}|} with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "non-positive before cursor was accepted");
  (match decode {|{"op":"unknown"}|} with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "unknown worker operation was accepted");
  (match
     decode
       {|{"op":"deliver","commandId":"delivery","text":"message","action":"later"}|}
   with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "unknown delivery action was accepted");
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
          Alcotest.test_case "session registry archive" `Quick
            test_session_registry;
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
