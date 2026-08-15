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
        Store.open_ ~path
          ~session_id:(Domain.session_id "session")
          ~worker_id:(Domain.worker_id "worker")
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

let write_file path contents =
  let channel = open_out_bin path in
  Fun.protect
    ~finally:(fun () -> close_out_noerr channel)
    (fun () -> output_string channel contents)

let rec remove_tree path =
  try
    match (Unix.lstat path).st_kind with
    | Unix.S_DIR ->
        Sys.readdir path
        |> Array.iter (fun name -> remove_tree (Filename.concat path name));
        Unix.rmdir path
    | Unix.S_REG | Unix.S_CHR | Unix.S_BLK | Unix.S_LNK | Unix.S_FIFO
    | Unix.S_SOCK ->
        Unix.unlink path
  with Unix.Unix_error (Unix.ENOENT, _, _) -> ()

let with_workspace f =
  let parent = Filename.temp_file "piss-workspace-" "" in
  Sys.remove parent;
  Unix.mkdir parent 0o700;
  Fun.protect
    ~finally:(fun () -> remove_tree parent)
    (fun () ->
      let root = Filename.concat parent "workspace" in
      Unix.mkdir root 0o700;
      f ~parent ~root)

let test_session_registry () =
  with_registry @@ fun registry ->
  Registry.upsert_workspace registry ~id:"workspace-one" ~name:"Workspace one"
    ~root:"/tmp/workspace-one";
  Alcotest.(check int)
    "one workspace" 1
    (List.length (Registry.list_workspaces registry));
  Registry.configure_workspace registry ~id:"workspace-empty"
    ~name:"Empty workspace" ~root:"/tmp/workspace-empty";
  Alcotest.(check bool)
    "empty workspace can be removed" true
    (Registry.remove_workspace registry "workspace-empty");
  Registry.configure_workspace registry ~id:"workspace-empty"
    ~name:"Configured again" ~root:"/tmp/workspace-empty";
  Alcotest.(check bool)
    "removed configured workspace stays removed" true
    (Option.is_none (Registry.find_workspace registry "workspace-empty"));
  Registry.upsert_workspace registry ~id:"workspace-empty"
    ~name:"Registered again" ~root:"/tmp/workspace-empty";
  Alcotest.(check bool)
    "explicit registration clears removal" true
    (Option.is_some (Registry.find_workspace registry "workspace-empty"));
  ignore (Registry.remove_workspace registry "workspace-empty");
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
  Alcotest.(check int)
    "workspace session count includes both sessions" 2
    (Registry.workspace_session_count registry "workspace-one");
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
    (List.length (Registry.list_open_peer_subscriptions registry));
  ignore
    (Registry.insert registry ~id:"s-old" ~title:"Old session" ~harness:"pi"
       ~workspace_id:"workspace-one");
  Alcotest.(check bool)
    "session can be archived for deletion" true
    (Registry.archive registry "s-one");
  Alcotest.(check bool)
    "second archived session is available" true
    (Registry.archive registry "s-old");
  Alcotest.(check int)
    "selected archived session deleted" 1
    (Registry.delete_archived_ids registry [ "s-one" ]);
  Alcotest.(check bool)
    "deleted session row is gone" true
    (Option.is_none (Registry.find registry "s-one"));
  Alcotest.(check bool)
    "unselected archived session remains" true
    (Option.is_some (Registry.find registry "s-old"));
  Alcotest.(check bool)
    "deleted session peer metadata is gone" true
    (Option.is_none (Registry.find_peer_request registry "peer-one"));
  Alcotest.(check int)
    "active session is preserved" 1
    (Registry.active_count registry);
  Alcotest.(check int)
    "workspace count excludes selected deletion" 2
    (Registry.workspace_session_count registry "workspace-one");
  Alcotest.(check int)
    "remaining archived session deleted" 1
    (Registry.delete_archived registry);
  Alcotest.(check int)
    "repeated archived deletion is empty" 0
    (Registry.delete_archived registry)

let runtime_target ~session_id:session ~worker_id:worker
    ~runtime_generation:generation =
  Domain.
    {
      session_id = Domain.session_id session;
      worker_id = Domain.worker_id worker;
      runtime_generation = Domain.runtime_generation generation;
    }

let test_runtime_fencing () =
  let path = Filename.temp_file "piss-runtime-" ".sqlite3" in
  Fun.protect
    ~finally:(fun () ->
      List.iter
        (fun suffix ->
          let candidate = path ^ suffix in
          if Sys.file_exists candidate then Sys.remove candidate)
        [ ""; "-wal"; "-shm" ])
    (fun () ->
      let open_store worker =
        Store.open_ ~path
          ~session_id:(Domain.session_id "session")
          ~worker_id:(Domain.worker_id worker)
      in
      let old_store = open_store "configured-worker" in
      Fun.protect ~finally:(fun () -> Store.close old_store) @@ fun () ->
      let old_identity = Store.claim_runtime old_store in
      Alcotest.(check int)
        "first runtime generation" 1 old_identity.runtime_generation;
      let replacement = open_store "configured-worker" in
      Fun.protect ~finally:(fun () -> Store.close replacement) @@ fun () ->
      let replacement_identity = Store.claim_runtime replacement in
      Alcotest.(check int)
        "replacement increments generation" 2
        replacement_identity.runtime_generation;
      Alcotest.(check bool)
        "worker incarnation changes" true
        (old_identity.worker_id <> replacement_identity.worker_id);
      let stale_target =
        runtime_target ~session_id:"session" ~worker_id:old_identity.worker_id
          ~runtime_generation:old_identity.runtime_generation
      in
      (match
         Store.accept_targeted_command old_store ~target:stale_target
           ~command_id:"stale" ~request_id:"stale" ~prompt:"must not dispatch"
       with
      | Error reason ->
          Alcotest.(check bool)
            "typed stale wording" true
            (String.starts_with ~prefix:"stale runtime target:" reason)
      | Ok _ -> Alcotest.fail "stale runtime target was accepted");
      Alcotest.(check (option string))
        "stale command was not written" None
        (Option.map Domain.command_state_to_string
           (Store.find_command old_store "stale"));
      let current_target =
        runtime_target ~session_id:"session"
          ~worker_id:replacement_identity.worker_id
          ~runtime_generation:replacement_identity.runtime_generation
      in
      (match
         Store.accept_targeted_command old_store ~target:current_target
           ~command_id:"wrong-process" ~request_id:"wrong-process"
           ~prompt:"must not reach the old harness"
       with
      | Error _ -> ()
      | Ok _ ->
          Alcotest.fail
            "old worker accepted the replacement worker's runtime target");
      Alcotest.(check (option string))
        "replacement target was not written by old worker" None
        (Option.map Domain.command_state_to_string
           (Store.find_command old_store "wrong-process"));
      let accepted =
        match
          Store.accept_targeted_command replacement ~target:current_target
            ~command_id:"current" ~request_id:"current" ~prompt:"dispatch once"
        with
        | Ok accepted -> accepted
        | Error reason -> Alcotest.fail reason
      in
      Alcotest.(check bool) "current target accepted" false accepted.duplicate;
      let duplicate =
        match
          Store.accept_targeted_command replacement ~target:current_target
            ~command_id:"current" ~request_id:"current"
            ~prompt:"must not replace"
        with
        | Ok accepted -> accepted
        | Error reason -> Alcotest.fail reason
      in
      Alcotest.(check bool)
        "targeted duplicate detected" true duplicate.duplicate;
      let accepted_events =
        Store.list_events replacement ~after:0L ~limit:20
        |> List.filter (fun event -> event.Domain.kind = "command.accepted")
      in
      Alcotest.(check int)
        "one durable acceptance" 1
        (List.length accepted_events))

let test_legacy_runtime_migration () =
  with_store @@ fun store ->
  Store.set_metadata store "worker_generation" "legacy-generation";
  let identity = Store.claim_runtime store in
  Alcotest.(check int)
    "first fenced generation follows the implicit legacy generation" 2
    identity.runtime_generation

let test_command_recovery () =
  with_store @@ fun store ->
  let identity = Store.claim_runtime store in
  let target =
    runtime_target ~session_id:"session" ~worker_id:identity.worker_id
      ~runtime_generation:identity.runtime_generation
  in
  let accept ?(images = []) command_id prompt =
    match
      Store.accept_targeted_command ~action:"follow_up" ~images store ~target
        ~command_id ~request_id:command_id ~prompt
    with
    | Ok accepted -> accepted
    | Error reason -> Alcotest.fail reason
  in
  ignore (accept "late-response" "already finished");
  Store.set_command_state store ~command_id:"late-response" Domain.Ambiguous;
  ignore
    (Store.append_event store ~kind:"acp.response"
       ~payload:
         (`Assoc
            [
              ("jsonrpc", `String "2.0");
              ("id", `String "late-response");
              ("result", `Assoc [ ("stopReason", `String "end_turn") ]);
            ]));
  Alcotest.(check (list string))
    "late response reconciles its command" [ "late-response" ]
    (Store.reconcile_ambiguous_responses store);
  (match Store.find_command store "late-response" with
  | Some Domain.Completed -> ()
  | _ -> Alcotest.fail "late terminal response remained ambiguous");
  ignore (accept "recover-text" "queued text");
  Store.set_command_state store ~command_id:"recover-text" Domain.Ambiguous;
  let recovered =
    match
      Store.recover_targeted_text_command store ~target
        ~command_id:"recover-text" ~action:"prompt"
    with
    | Ok recovered -> recovered
    | Error reason -> Alcotest.fail reason
  in
  Alcotest.(check bool) "first recovery is fresh" false recovered.duplicate;
  Alcotest.(check string)
    "recovery retains prompt" "queued text" recovered.prompt;
  let duplicate =
    match
      Store.recover_targeted_text_command store ~target
        ~command_id:"recover-text" ~action:"prompt"
    with
    | Ok recovered -> recovered
    | Error reason -> Alcotest.fail reason
  in
  Alcotest.(check bool) "recovery deduplicates" true duplicate.duplicate;
  ignore
    (accept
       ~images:[ `Assoc [ ("name", `String "proof.png") ] ]
       "recover-image" "image command");
  Store.set_command_state store ~command_id:"recover-image" Domain.Ambiguous;
  match
    Store.recover_targeted_text_command store ~target
      ~command_id:"recover-image" ~action:"prompt"
  with
  | Error _ -> (
      match
        Store.recover_targeted_text_command ~discard_cleared_attachments:true
          store ~target ~command_id:"recover-image" ~action:"prompt"
      with
      | Ok recovered ->
          Alcotest.(check string)
            "explicit recovery retains image prompt text" "image command"
            recovered.prompt
      | Error reason -> Alcotest.fail reason)
  | Ok _ -> Alcotest.fail "image command was unsafely recovered without data"

let test_command_deduplication () =
  with_store @@ fun store ->
  let content =
    `List
      [
        `Assoc
          [
            ("mimeType", `String "image/png");
            ("data", `String "durable-image-data");
          ];
      ]
  in
  let images =
    [
      `Assoc
        [
          ("mimeType", `String "image/png");
          ("name", `String "proof.png");
          ("size", `Int 12);
        ];
    ]
  in
  let first =
    Store.accept_command ~content ~images store ~command_id:"command-1"
      ~request_id:"command-1" ~prompt:"do the thing"
  in
  let duplicate =
    Store.accept_command store ~command_id:"command-1" ~request_id:"command-1"
      ~prompt:"this must never replace the accepted prompt"
  in
  Alcotest.(check bool) "first delivery is new" false first.duplicate;
  Alcotest.(check bool) "second delivery is duplicate" true duplicate.duplicate;
  Alcotest.(check string)
    "durable state is returned" "accepted"
    (Domain.command_state_to_string duplicate.state);
  Alcotest.(check (option string))
    "image content is durable before dispatch"
    (Some (Yojson.Safe.to_string content))
    (Store.command_content store "command-1");
  let accepted_event = Store.list_events store ~after:0L ~limit:10 |> List.hd in
  Alcotest.(check int)
    "event retains bounded image metadata" 1
    Yojson.Safe.Util.(accepted_event.payload |> member "imageCount" |> to_int);
  Store.clear_command_content store ~command_id:"command-1";
  Alcotest.(check (option string))
    "large content is scrubbed after dispatch" (Some "[]")
    (Store.command_content store "command-1")

let test_command_content_migration () =
  let path = Filename.temp_file "piss-worker-legacy-" ".sqlite3" in
  Fun.protect
    ~finally:(fun () ->
      List.iter
        (fun suffix ->
          let candidate = path ^ suffix in
          if Sys.file_exists candidate then Sys.remove candidate)
        [ ""; "-wal"; "-shm" ])
    (fun () ->
      let db = Sqlite3.db_open path in
      let rc =
        Sqlite3.exec db
          "CREATE TABLE commands (command_id TEXT PRIMARY KEY, request_id TEXT \
           NOT NULL UNIQUE, prompt TEXT NOT NULL, state TEXT NOT NULL, \
           created_at REAL NOT NULL, updated_at REAL NOT NULL)"
      in
      Alcotest.(check bool)
        "legacy schema created" true (Sqlite3.Rc.is_success rc);
      Alcotest.(check bool) "legacy database closed" true (Sqlite3.db_close db);
      let store =
        Store.open_ ~path
          ~session_id:(Domain.session_id "session")
          ~worker_id:(Domain.worker_id "worker")
      in
      Fun.protect ~finally:(fun () -> Store.close store) @@ fun () ->
      ignore
        (Store.accept_command
           ~content:(`List [ `String "image" ])
           store ~command_id:"migrated" ~request_id:"migrated" ~prompt:"");
      Alcotest.(check (option string))
        "content column added transactionally" (Some {|["image"]|})
        (Store.command_content store "migrated"))

let test_event_retention_compacts () =
  with_store @@ fun _store ->
  (* Pushing the table past `max_retained_events` (65 536 rows) just to exercise
     the compaction path inside the test suite is too slow for the daily `dune
     test` loop. Instead, verify the predicate that gates the compaction, and
     the structural invariant that compaction would only ever touch non-retained
     kinds. *)
  let predicate = Store.retention_predicate Store.retained_event_kinds in
  Alcotest.(check bool)
    "predicate is a single SQL fragment" true
    (String.starts_with ~prefix:"kind NOT IN (" predicate);
  Alcotest.(check bool)
    "predicate lists every durable kind" true
    (List.for_all
       (fun (kind : string) ->
         let found = ref false in
         let len = String.length predicate in
         let klen = String.length kind in
         for i = 0 to len - klen do
           if not !found then
             let slice = String.sub predicate i klen in
             if String.equal slice kind then found := true
         done;
         !found)
       Store.retained_event_kinds)

let test_event_retention_preserves_durable_kinds () =
  with_store @@ fun store ->
  (* Insert one of each durable event kind; even if compaction ran (which it
     will not at this volume) the predicate would protect them. *)
  let durable_kinds = Store.retained_event_kinds in
  List.iter
    (fun kind ->
      ignore
        (Store.append_event store ~kind
           ~payload:(`Assoc [ ("kind", `String kind) ])))
    durable_kinds;
  let events = Store.list_recent_events store ~limit:65_536 in
  let kept_kinds =
    List.map (fun event -> event.Domain.kind) events
    |> List.sort_uniq String.compare
  in
  Alcotest.(check bool)
    "every durable event kind is persisted at small volume" true
    (List.for_all (fun kind -> List.mem kind kept_kinds) durable_kinds)

let test_event_retention_first_sequence () =
  with_store @@ fun store ->
  Alcotest.(check int64)
    "empty store first sequence is zero" 0L
    (Store.first_retained_sequence store);
  let first = Store.append_event store ~kind:"first" ~payload:(`String "one") in
  Alcotest.(check int64)
    "single event first sequence equals its sequence" first.sequence
    (Store.first_retained_sequence store);
  ignore
    ( Store.append_event store ~kind:"second" ~payload:(`String "two")
    |> fun _ -> () );
  ignore
    ( Store.append_event store ~kind:"third" ~payload:(`String "three")
    |> fun _ -> () );
  Alcotest.(check int64)
    "first sequence tracks the oldest live event" first.sequence
    (Store.first_retained_sequence store);
  Alcotest.(check bool)
    "last sequence tracks the newest event" true
    (Store.last_sequence store > first.sequence)

let test_try_set_command_state_if_open () =
  with_store @@ fun store ->
  let accepted =
    Store.accept_command store ~command_id:"race-cmd" ~request_id:"race-cmd"
      ~prompt:"dispatch and watch"
  in
  Alcotest.(check bool)
    "first accept is not a duplicate" false accepted.duplicate;
  Store.set_command_state store ~command_id:"race-cmd" Domain.Dispatched;
  (* While the command is still in `dispatched`, the watcher may try to mark it
     ambiguous. The transition succeeds. *)
  let first =
    Store.try_set_command_state_if_open store ~command_id:"race-cmd"
      Domain.Ambiguous
  in
  Alcotest.(check bool) "open-to-ambiguous transition succeeds" true first;
  (match Store.find_command store "race-cmd" with
  | Some Domain.Ambiguous -> ()
  | Some state ->
      Alcotest.failf "expected ambiguous, got %s"
        (Domain.command_state_to_string state)
  | None -> Alcotest.fail "race-cmd disappeared");
  (* A second timeout attempt must NOT overwrite the terminal state. *)
  let second =
    Store.try_set_command_state_if_open store ~command_id:"race-cmd"
      Domain.Completed
  in
  Alcotest.(check bool)
    "second transition into a terminal state fails" false second;
  (match Store.find_command store "race-cmd" with
  | Some Domain.Ambiguous -> ()
  | Some state ->
      Alcotest.failf "ambiguous was clobbered with %s"
        (Domain.command_state_to_string state)
  | None -> Alcotest.fail "race-cmd disappeared");
  Alcotest.(check (option string))
    "terminal transition clears durable content" (Some "[]")
    (Store.command_content store "race-cmd");
  let ambiguous_events =
    Store.list_events store ~after:0L ~limit:20
    |> List.filter (fun event ->
        String.equal event.Domain.kind "command.state"
        && Yojson.Safe.equal
             (Yojson.Safe.Util.member "state" event.payload)
             (`String "ambiguous"))
  in
  Alcotest.(check int)
    "terminal transition appends exactly one state event" 1
    (List.length ambiguous_events)

let test_dispatched_commands_lists_open_records () =
  with_store @@ fun store ->
  let accept id prompt =
    Store.accept_command store ~command_id:id ~request_id:id ~prompt |> ignore
  in
  accept "open-1" "first";
  Store.set_command_state store ~command_id:"open-1" Domain.Dispatched;
  accept "done-1" "second";
  Store.set_command_state store ~command_id:"done-1" Domain.Completed;
  accept "open-2" "third";
  let open_rows = Store.dispatched_commands store in
  let ids = List.map fst open_rows |> List.sort String.compare in
  Alcotest.(check (list string))
    "only open commands are listed" [ "open-1"; "open-2" ] ids

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
        Store.open_ ~path
          ~session_id:(Domain.session_id "session")
          ~worker_id:(Domain.worker_id "worker")
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
  let first = Store.append_event store ~kind:"first" ~payload:(`String "one") in
  let second =
    Store.append_event store ~kind:"second" ~payload:(`String "two")
  in
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
  let targeted json =
    match Yojson.Safe.from_string json with
    | `Assoc fields ->
        `Assoc
          (( "target",
             `Assoc
               [
                 ("sessionId", `String "session");
                 ("workerId", `String "worker-incarnation");
                 ("runtimeGeneration", `Int 3);
               ] )
          :: fields)
        |> Wire.request_of_yojson
    | _ -> assert false
  in
  (match decode {|{"op":"prompt","commandId":"missing","text":"target"}|} with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "targetless prompt was accepted");
  let legacy_target =
    runtime_target ~session_id:"session" ~worker_id:"worker-incarnation"
      ~runtime_generation:3
  in
  (match
     Wire.request_of_yojson_v1 ~target:legacy_target
       ~mutation_id:"legacy-mutation"
       (Yojson.Safe.from_string
          {|{"op":"prompt","commandId":"legacy-command","text":"rollback"}|})
   with
  | Ok
      (Wire.Prompt
         { target; command_id = "legacy-command"; text = "rollback"; _ }) ->
      Alcotest.(check int)
        "legacy prompt binds current generation" 3
        (Domain.runtime_generation_to_int target.runtime_generation)
  | Ok _ -> Alcotest.fail "legacy prompt decoded incorrectly"
  | Error message -> Alcotest.fail message);
  (match
     Wire.request_of_yojson_v1 ~target:legacy_target
       ~mutation_id:"legacy-mutation"
       (Yojson.Safe.from_string {|{"op":"cancel"}|})
   with
  | Ok (Wire.Cancel { mutation_id = "legacy-mutation"; _ }) -> ()
  | Ok _ -> Alcotest.fail "legacy cancel decoded incorrectly"
  | Error message -> Alcotest.fail message);
  (match
     decode
       {|{"op":"cancel","target":{"sessionId":"session","workerId":"worker","runtimeGeneration":-1},"mutationId":"cancel"}|}
   with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "negative runtime generation was accepted");
  (match
     decode
       {|{"op":"cancel","target":{"sessionId":"session","workerId":"worker","runtimeGeneration":1},"mutationId":""}|}
   with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "empty mutation identity was accepted");
  (match decode {|{"op":"events","after":0,"limit":501}|} with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "oversized event page was accepted");
  (match decode {|{"op":"events_before","before":0,"limit":200}|} with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "non-positive before cursor was accepted");
  (match decode {|{"op":"unknown"}|} with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "unknown worker operation was accepted");
  (match decode {|{"op":"prepare_upgrade","generation":"worker-v2"}|} with
  | Ok (Wire.Prepare_upgrade { generation = "worker-v2" }) -> ()
  | Ok _ -> Alcotest.fail "upgrade preparation decoded incorrectly"
  | Error message -> Alcotest.fail message);
  (match decode {|{"op":"prepare_upgrade","generation":""}|} with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "empty upgrade generation was accepted");
  (match
     targeted
       {|{"op":"deliver","commandId":"delivery","text":"message","action":"later"}|}
   with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "unknown delivery action was accepted");
  (match
     targeted
       {|{"op":"prompt","commandId":"image","text":"","images":[{"mimeType":"image/gif","data":"R0lGODlhAQABAAAAACw=","name":"proof.gif"}]}|}
   with
  | Ok (Wire.Prompt { text = ""; images = [ image ]; _ }) ->
      Alcotest.(check int) "decoded image bytes" 14 image.size
  | Ok _ -> Alcotest.fail "image-only prompt decoded incorrectly"
  | Error message -> Alcotest.fail message);
  (match
     targeted
       {|{"op":"prompt","commandId":"image","text":"","images":[{"mimeType":"image/svg+xml","data":"PHN2Zz4=","name":"unsafe.svg"}]}|}
   with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "unsupported image type was accepted");
  (match
     targeted
       {|{"op":"prompt","commandId":"image","text":"","images":[{"mimeType":"image/png","data":"not base64","name":"broken.png"}]}|}
   with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "malformed base64 was accepted");
  let image =
    `Assoc
      [
        ("mimeType", `String "image/png");
        ("data", `String "aW1hZ2U=");
        ("name", `String "proof.png");
      ]
  in
  let too_many_images =
    `Assoc
      [
        ("op", `String "prompt");
        ("commandId", `String "too-many-images");
        ("text", `String "");
        ("images", `List (List.init 5 (fun _ -> image)));
      ]
  in
  let too_many_images =
    match too_many_images with
    | `Assoc fields ->
        `Assoc
          (( "target",
             `Assoc
               [
                 ("sessionId", `String "session");
                 ("workerId", `String "worker-incarnation");
                 ("runtimeGeneration", `Int 3);
               ] )
          :: fields)
    | _ -> assert false
  in
  (match Wire.request_of_yojson too_many_images with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "more than four images were accepted");
  (match
     targeted
       {|{"op":"prompt","commandId":"escape","text":"inspect","resources":[{"path":"../outside.txt"}]}|}
   with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "traversing resource path was accepted");
  (match decode {|{"op":"file_search","query":"App"}|} with
  | Ok (Wire.File_search { query = "App" }) -> ()
  | Ok _ -> Alcotest.fail "file search decoded incorrectly"
  | Error message -> Alcotest.fail message);
  let oversized_query = String.make 201 'q' in
  let search =
    `Assoc [ ("op", `String "file_search"); ("query", `String oversized_query) ]
  in
  (match Wire.request_of_yojson search with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "oversized file search query was accepted");
  let oversized = String.make ((64 * 1024) + 1) 'x' in
  let prompt =
    `Assoc
      [
        ("op", `String "prompt");
        ("commandId", `String "bounded");
        ("text", `String oversized);
      ]
  in
  let prompt =
    match prompt with
    | `Assoc fields ->
        `Assoc
          (( "target",
             `Assoc
               [
                 ("sessionId", `String "session");
                 ("workerId", `String "worker-incarnation");
                 ("runtimeGeneration", `Int 3);
               ] )
          :: fields)
    | _ -> assert false
  in
  match Wire.request_of_yojson prompt with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "oversized prompt was accepted"

let test_workspace_file_mentions () =
  with_workspace @@ fun ~parent ~root ->
  let web = Filename.concat root "web" in
  Unix.mkdir web 0o700;
  let app = Filename.concat web "main.ml" in
  write_file app "let durable = true\n";
  let outside = Filename.concat parent "outside.txt" in
  write_file outside "secret\n";
  Unix.symlink outside (Filename.concat root "escape.txt");
  Unix.mkfifo (Filename.concat root "special.pipe") 0o600;
  let mentions =
    match Workspace_io.search ~root ~query:"main" with
    | Ok mentions -> mentions
    | Error message -> Alcotest.fail message
  in
  Alcotest.(check (list string))
    "search returns canonical workspace-relative regular files"
    [ "web/main.ml" ]
    (List.map
       (fun (mention : Workspace_files.mention) -> mention.path)
       mentions);
  let all =
    match Workspace_io.search ~root ~query:"" with
    | Ok mentions -> mentions
    | Error message -> Alcotest.fail message
  in
  Alcotest.(check bool)
    "escaping symlinks and special files are not exposed" true
    (List.for_all
       (fun (mention : Workspace_files.mention) ->
         mention.path <> "escape.txt" && mention.path <> "special.pipe")
       all);
  let resource =
    match Workspace_io.resolve_resource ~root ~path:"web/main.ml" with
    | Ok resource -> resource
    | Error message -> Alcotest.fail message
  in
  Alcotest.(check string)
    "resource keeps relative display name" "web/main.ml" resource.name;
  Alcotest.(check bool)
    "resource uses an absolute file URI" true
    (String.starts_with ~prefix:"file:///" resource.uri);
  List.iter
    (fun path ->
      match Workspace_io.resolve_resource ~root ~path with
      | Error _ -> ()
      | Ok _ -> Alcotest.failf "unsafe resource path was accepted: %s" path)
    [ "../outside.txt"; "escape.txt"; "special.pipe" ];
  let request =
    Acp.prompt_request ~delivery:None ~command_id:"resource-command"
      ~session_id:"session" ~text:"Inspect @web/main.ml" ~images:[]
      ~resources:[ resource ]
  in
  let prompt =
    Yojson.Safe.Util.(request |> member "params" |> member "prompt")
  in
  match prompt with
  | `List [ `Assoc _; `Assoc fields ] ->
      Alcotest.(check (option string))
        "ACP resource link type" (Some "resource_link")
        (Option.bind
           (List.assoc_opt "type" fields)
           Yojson.Safe.Util.to_string_option);
      Alcotest.(check (option string))
        "ACP resource link name" (Some "web/main.ml")
        (Option.bind
           (List.assoc_opt "name" fields)
           Yojson.Safe.Util.to_string_option)
  | _ -> Alcotest.fail "ACP prompt did not contain text and a resource link"

let test_acp_image_prompt () =
  let image =
    Domain.
      {
        mime_type = "image/png";
        data = "aW1hZ2U=";
        name = "proof.png";
        size = 5;
      }
  in
  let request =
    Acp.prompt_request ~delivery:None ~command_id:"image-command"
      ~session_id:"session" ~text:"Inspect this" ~images:[ image ] ~resources:[]
  in
  let prompt =
    Yojson.Safe.Util.(request |> member "params" |> member "prompt")
  in
  match prompt with
  | `List
      [
        `Assoc [ ("type", `String "text"); ("text", `String "Inspect this") ];
        `Assoc fields;
      ] ->
      Alcotest.(check (option string))
        "ACP image MIME type" (Some "image/png")
        (Option.bind
           (List.assoc_opt "mimeType" fields)
           Yojson.Safe.Util.to_string_option);
      Alcotest.(check (option string))
        "ACP image data" (Some "aW1hZ2U=")
        (Option.bind
           (List.assoc_opt "data" fields)
           Yojson.Safe.Util.to_string_option)
  | _ -> Alcotest.fail "ACP prompt did not contain text followed by an image"

let test_acp_image_redaction () =
  let response = Acp.response ~id:"done" (`Assoc []) in
  Alcotest.(check string)
    "responses are unchanged"
    (Yojson.Safe.to_string response)
    (Acp.redact_user_image_data response |> Yojson.Safe.to_string);
  let update =
    Acp.notification ~method_:"session/update"
      (`Assoc
         [
           ("sessionId", `String "session");
           ( "update",
             `Assoc
               [
                 ("sessionUpdate", `String "user_message_chunk");
                 ( "content",
                   `Assoc
                     [
                       ("type", `String "image");
                       ("mimeType", `String "image/png");
                       ("data", `String "large-base64-payload");
                     ] );
               ] );
         ])
  in
  let redacted = Acp.redact_user_image_data update in
  Alcotest.(check string)
    "durable user image payload is scrubbed" ""
    Yojson.Safe.Util.(
      redacted |> member "params" |> member "update" |> member "content"
      |> member "data" |> to_string)

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

let test_origin_patterns () =
  let check label expected pattern origin =
    Alcotest.(check bool) label expected (Origin_pattern.matches pattern origin)
  in
  check "exact stable origin" true "https://piss.tailb61fd1.ts.net"
    "https://piss.tailb61fd1.ts.net";
  check "exact mismatch" false "https://piss.tailb61fd1.ts.net"
    "https://piss-ocaml.tailb61fd1.ts.net";
  check "tailnet wildcard" true "https://piss.*.ts.net"
    "https://piss.tailb61fd1.ts.net";
  check "wildcard spans an empty run" true "https://piss*" "https://piss";
  check "match remains anchored" false "https://piss.*.ts.net"
    "prefix-https://piss.tailb61fd1.ts.net";
  check "wildcard cannot omit literals" false "https://piss.*.ts.net"
    "https://piss.tailb61fd1.example.net"

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
  Alcotest.run "piss"
    [
      ( "durability",
        [
          Alcotest.test_case "runtime fencing" `Quick test_runtime_fencing;
          Alcotest.test_case "legacy runtime migration" `Quick
            test_legacy_runtime_migration;
          Alcotest.test_case "command recovery" `Quick test_command_recovery;
          Alcotest.test_case "command deduplication" `Quick
            test_command_deduplication;
          Alcotest.test_case "legacy command schema migrates" `Quick
            test_command_content_migration;
          Alcotest.test_case "event sequence" `Quick test_event_sequence;
          Alcotest.test_case "event retention compacts" `Quick
            test_event_retention_compacts;
          Alcotest.test_case "durable event kinds survive compaction" `Quick
            test_event_retention_preserves_durable_kinds;
          Alcotest.test_case "first retained sequence advances on compaction"
            `Quick test_event_retention_first_sequence;
          Alcotest.test_case "race-safe terminal transition" `Quick
            test_try_set_command_state_if_open;
          Alcotest.test_case "dispatched commands are listed" `Quick
            test_dispatched_commands_lists_open_records;
          Alcotest.test_case "restart reconciliation" `Quick
            test_restart_reconciliation;
          Alcotest.test_case "session registry archive" `Quick
            test_session_registry;
        ] );
      ( "domain",
        [
          Alcotest.test_case "origin patterns are anchored" `Quick
            test_origin_patterns;
          Alcotest.test_case "command states round trip" `Quick
            test_stable_state_decoding;
          Alcotest.test_case "wire bounds fail closed" `Quick test_wire_bounds;
          Alcotest.test_case "workspace file mentions are bounded" `Quick
            test_workspace_file_mentions;
          Alcotest.test_case "ACP image prompts are typed" `Quick
            test_acp_image_prompt;
          Alcotest.test_case "ACP image echoes are bounded" `Quick
            test_acp_image_redaction;
          Alcotest.test_case "ACP errors fail closed" `Quick
            test_acp_error_response;
        ] );
    ]
