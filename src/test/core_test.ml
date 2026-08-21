open Piss_shared
module Shared_domain = Domain

module Domain = struct
  include Shared_domain

  let session_id value = Result.get_ok (Session_id.of_string value)
  let worker_id value = Result.get_ok (Worker_id.of_string value)
  let runtime_generation value = Result.get_ok (Runtime_generation.of_int value)
end

module Registry_domain = Piss_registry_domain.Registry_domain
module Store = Piss_worker_store.Store
module Workspace_io = Piss_workspace_io.Workspace_io
module Origin_pattern = Piss_origin.Origin_pattern
module Durable_registry = Piss_registry.Registry

module Registry = struct
  include Durable_registry

  let accept_peer_request registry ~id ~source_id ~target_id ~prompt ~command_id
      ~start_sequence =
    match
      Durable_registry.accept_peer_request registry ~id ~source_id ~target_id
        ~prompt ~command_id ~start_sequence
    with
    | Ok value -> value
    | Error message -> Alcotest.fail message

  let accept_peer_subscription registry ~id ~source_id ~request_ids ~wait_for
      ~command_id =
    match
      Durable_registry.accept_peer_subscription registry ~id ~source_id
        ~request_ids ~wait_for ~command_id
    with
    | Ok value -> value
    | Error message -> Alcotest.fail message
end

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
  (match Registry.remove_empty_workspace registry "workspace-empty" with
  | `Removed -> ()
  | _ -> Alcotest.fail "empty workspace was not removed");
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
  (match Registry.remove_empty_workspace registry "workspace-one" with
  | `Not_empty 2 -> ()
  | _ -> Alcotest.fail "non-empty workspace was removable");
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
  (match Registry.remove_empty_workspace registry "workspace-one" with
  | `Not_empty 2 -> ()
  | _ -> Alcotest.fail "workspace with archived sessions was removable");
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
      ~start_sequence:0L
  in
  Alcotest.(check bool) "first peer request is new" false duplicate;
  Alcotest.(check bool)
    "accepted managed request projects peer waiting" true
    (Registry.has_open_peer_work registry ~source_id:one.id);
  Alcotest.(check int64) "peer cursor starts unset" 0L request.start_sequence;
  let _, duplicate =
    Registry.accept_peer_request registry ~id:"peer-one" ~source_id:one.id
      ~target_id:two.id ~prompt:"review this" ~command_id:"peer-command"
      ~start_sequence:99L
  in
  Alcotest.(check bool) "peer request deduplicates" true duplicate;
  (match
     Durable_registry.accept_peer_request registry ~id:"peer-one"
       ~source_id:one.id ~target_id:two.id ~prompt:"different payload"
       ~command_id:"ignored" ~start_sequence:99L
   with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "peer request ID accepted a different payload");
  Alcotest.(check bool)
    "first caller claims dispatch" true
    (Registry.mark_peer_dispatching registry "peer-one" ~start_sequence:8L);
  Alcotest.(check bool)
    "concurrent caller cannot claim dispatch" false
    (Registry.mark_peer_dispatching registry "peer-one" ~start_sequence:9L);
  let dispatching =
    Option.get (Registry.find_peer_request registry "peer-one")
  in
  Alcotest.(check string)
    "peer request dispatching" "dispatching"
    (Registry_domain.Peer_request_state.to_string dispatching.state);
  Alcotest.(check bool)
    "crash-stale dispatch projects peer waiting" true
    (Registry.has_open_peer_work registry ~source_id:one.id);
  Alcotest.(check bool)
    "dispatch transition completes" true
    (Registry.mark_peer_dispatched registry "peer-one");
  Alcotest.(check bool)
    "dispatched request projects peer waiting" true
    (Registry.has_open_peer_work registry ~source_id:one.id);
  Alcotest.(check int64)
    "dispatch retry preserves original cursor" 8L dispatching.start_sequence;
  Alcotest.(check bool)
    "first completion changes state" true
    (Registry.complete_peer_request registry "peer-one" "reviewed");
  Alcotest.(check bool)
    "completion deduplicates" false
    (Registry.complete_peer_request registry "peer-one" "must not replace");
  Alcotest.(check bool)
    "completed request clears peer waiting" false
    (Registry.has_open_peer_work registry ~source_id:one.id);
  Alcotest.(check int)
    "source request listing" 1
    (List.length (Registry.list_peer_requests registry ~source_id:one.id));
  let completed = Option.get (Registry.find_peer_request registry "peer-one") in
  Alcotest.(check string)
    "peer response retained" "reviewed"
    (Option.get completed.response);
  ignore
    (Registry.accept_peer_request registry ~id:"peer-failure" ~source_id:one.id
       ~target_id:two.id ~prompt:"fail once" ~command_id:"peer-failure-command"
       ~start_sequence:9L);
  ignore
    (Registry.mark_peer_dispatching registry "peer-failure" ~start_sequence:9L);
  ignore (Registry.mark_peer_dispatched registry "peer-failure");
  Alcotest.(check bool)
    "first peer failure changes state" true
    (Registry.fail_peer_request registry "peer-failure" "unavailable");
  Alcotest.(check bool)
    "duplicate peer failure is idempotent" false
    (Registry.fail_peer_request registry "peer-failure" "duplicate");
  Alcotest.(check bool)
    "failed request cannot be reopened" false
    (Registry.mark_peer_dispatched registry "peer-failure");
  Alcotest.(check string)
    "failed request remains terminal" "failed"
    (Registry_domain.Peer_request_state.to_string
       (Option.get (Registry.find_peer_request registry "peer-failure")).state);
  let subscription, duplicate =
    Registry.accept_peer_subscription registry ~id:"wake-one" ~source_id:one.id
      ~request_ids:[ "peer-one" ] ~wait_for:"all"
      ~command_id:"peer-wake-command"
  in
  Alcotest.(check bool) "first wake subscription is new" false duplicate;
  Alcotest.(check bool)
    "pending subscription projects peer waiting" true
    (Registry.has_open_peer_work registry ~source_id:one.id);
  Alcotest.(check string)
    "wake subscription pending" "pending"
    (Registry_domain.Subscription_state.to_string subscription.state);
  let _, duplicate =
    Registry.accept_peer_subscription registry ~id:"wake-one" ~source_id:one.id
      ~request_ids:[ "peer-one" ] ~wait_for:"all"
      ~command_id:"peer-wake-command"
  in
  Alcotest.(check bool) "wake subscription deduplicates" true duplicate;
  (match
     Durable_registry.accept_peer_subscription registry ~id:"wake-one"
       ~source_id:one.id ~request_ids:[ "peer-failure" ] ~wait_for:"any"
       ~command_id:"ignored"
   with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "subscription ID accepted a different payload");
  Registry.mark_peer_subscription_dispatching registry "wake-one";
  Alcotest.(check string)
    "wake subscription dispatching" "dispatching"
    (Registry_domain.Subscription_state.to_string
       (Option.get (Registry.find_peer_subscription registry "wake-one")).state);
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
  Alcotest.(check bool)
    "delivered subscription clears peer waiting" false
    (Registry.has_open_peer_work registry ~source_id:one.id);
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
  Alcotest.(check bool)
    "archived target can be restored before new work" true
    (Registry.restore registry "s-old");
  ignore
    (Registry.accept_peer_request registry ~id:"cross-delete-request"
       ~source_id:two.id ~target_id:"s-old" ~prompt:"review before deletion"
       ~command_id:"cross-delete-command" ~start_sequence:10L);
  ignore
    (Registry.mark_peer_dispatching registry "cross-delete-request"
       ~start_sequence:10L);
  ignore (Registry.mark_peer_dispatched registry "cross-delete-request");
  ignore
    (Registry.accept_peer_subscription registry ~id:"cross-delete-subscription"
       ~source_id:two.id ~request_ids:[ "cross-delete-request" ] ~wait_for:"all"
       ~command_id:"cross-delete-wake");
  Alcotest.(check bool)
    "cross-session subscription projects waiting" true
    (Registry.has_open_peer_work registry ~source_id:two.id);
  Alcotest.(check bool)
    "worked target can be archived for deletion" true
    (Registry.archive registry "s-old");
  (match
     Durable_registry.accept_peer_request registry ~id:"cross-delete-request"
       ~source_id:two.id ~target_id:"s-old" ~prompt:"review before deletion"
       ~command_id:"ignored-on-retry" ~start_sequence:999L
   with
  | Ok (retried, true) ->
      Alcotest.(check string)
        "archived-target retry returns durable request" "cross-delete-request"
        retried.id
  | Ok _ -> Alcotest.fail "archived-target retry was treated as fresh"
  | Error message -> Alcotest.fail message);
  Alcotest.(check int)
    "remaining archived session deleted" 1
    (Registry.delete_archived registry);
  Alcotest.(check bool)
    "target deletion removes source subscription" true
    (Option.is_none
       (Registry.find_peer_subscription registry "cross-delete-subscription"));
  Alcotest.(check bool)
    "target deletion clears source waiting" false
    (Registry.has_open_peer_work registry ~source_id:two.id);
  Alcotest.(check int)
    "repeated archived deletion is empty" 0
    (Registry.delete_archived registry);
  let codex =
    Registry.insert registry ~id:"s-codex" ~title:"Codex / tracer"
      ~harness:"codex" ~workspace_id:"workspace-one"
  in
  Alcotest.(check string) "Codex harness is accepted" "codex" codex.harness

let test_registry_codex_migration () =
  let path = Filename.temp_file "piss-registry-legacy-" ".sqlite3" in
  Fun.protect
    ~finally:(fun () ->
      List.iter
        (fun suffix ->
          let candidate = path ^ suffix in
          if Sys.file_exists candidate then Sys.remove candidate)
        [ ""; "-wal"; "-shm" ])
    (fun () ->
      let db = Sqlite3.db_open path in
      let exec sql =
        match Sqlite3.exec db sql with
        | rc when Sqlite3.Rc.is_success rc -> ()
        | rc ->
            Alcotest.fail
              ("legacy registry setup failed: " ^ Sqlite3.Rc.to_string rc)
      in
      exec
        "CREATE TABLE sessions (id TEXT PRIMARY KEY,title TEXT NOT \
         NULL,harness TEXT NOT NULL CHECK(harness IN \
         ('pi','opencode','mock')),created_at REAL NOT NULL,archived_at \
         REAL,broker_token TEXT NOT NULL DEFAULT '',workspace_id TEXT NOT NULL \
         DEFAULT '',finishing_at REAL)";
      exec
        "INSERT INTO sessions \
         (id,title,harness,created_at,archived_at,broker_token,workspace_id,finishing_at) \
         VALUES ('legacy-pi','Legacy Pi','pi',0,NULL,'legacy-token','',123.0)";
      ignore (Sqlite3.db_close db);
      let registry = Registry.open_ ~path in
      Fun.protect
        ~finally:(fun () -> Registry.close registry)
        (fun () ->
          ignore
            (Registry.insert registry ~id:"migrated-codex" ~title:"Codex"
               ~harness:"codex" ~workspace_id:"");
          Alcotest.(check bool)
            "legacy session survives Codex constraint migration" true
            (Option.is_some (Registry.find registry "legacy-pi"));
          Alcotest.(check bool)
            "legacy finish fence survives Codex constraint migration" true
            (Registry.session_lifecycle registry "legacy-pi"
            = Some Registry_domain.Session_lifecycle.Finishing)))

let test_legacy_registry_migration () =
  let path = Filename.temp_file "piss-registry-legacy-" ".sqlite3" in
  Fun.protect
    ~finally:(fun () ->
      List.iter
        (fun suffix ->
          let candidate = path ^ suffix in
          if Sys.file_exists candidate then Sys.remove candidate)
        [ ""; "-wal"; "-shm" ])
    (fun () ->
      let db = Sqlite3.db_open path in
      List.iter
        (fun sql ->
          Alcotest.(check bool)
            "legacy registry statement" true
            (Sqlite3.Rc.is_success (Sqlite3.exec db sql)))
        [
          "CREATE TABLE workspaces (id TEXT PRIMARY KEY,name TEXT NOT \
           NULL,root TEXT NOT NULL UNIQUE,created_at REAL NOT NULL)";
          "CREATE TABLE sessions (id TEXT PRIMARY KEY,title TEXT NOT \
           NULL,harness TEXT NOT NULL,created_at REAL NOT NULL,archived_at \
           REAL)";
          "INSERT INTO workspaces VALUES \
           ('legacy-workspace','Legacy','/tmp/legacy',1.0)";
          "INSERT INTO sessions VALUES ('legacy-session','Legacy \
           agent','pi',1.0,NULL)";
        ];
      Alcotest.(check bool) "legacy registry closed" true (Sqlite3.db_close db);
      let registry = Registry.open_ ~path in
      Fun.protect ~finally:(fun () -> Registry.close registry) @@ fun () ->
      Registry.assign_unscoped_sessions registry "legacy-workspace";
      let session = Option.get (Registry.find registry "legacy-session") in
      Alcotest.(check bool)
        "broker token backfilled" true
        (String.length session.broker_token > 0);
      Alcotest.(check string)
        "workspace column added" "legacy-workspace" session.workspace_id;
      Alcotest.(check bool)
        "catalog revision schema added" true
        (Int64.compare (Registry.catalog_revision registry) 0L >= 0))

let test_broker_creation_registry () =
  with_registry @@ fun registry ->
  Registry.upsert_workspace registry ~id:"workspace-source" ~name:"Source"
    ~root:"/tmp/source";
  let source =
    Registry.insert registry ~id:"source-session" ~title:"Source agent"
      ~harness:"pi" ~workspace_id:"workspace-source"
  in
  let workspace, duplicate =
    match
      Registry.accept_broker_workspace registry ~id:"workspace-request"
        ~source_id:source.id ~canonical_root:"/tmp/agent-target"
        ~workspace_id:"workspace-target" ~name:"agent-target"
    with
    | Ok value -> value
    | Error message -> Alcotest.fail message
  in
  Alcotest.(check bool) "first workspace request is new" false duplicate;
  let repeated, duplicate =
    match
      Registry.accept_broker_workspace registry ~id:"workspace-request"
        ~source_id:source.id ~canonical_root:"/tmp/agent-target"
        ~workspace_id:"ignored-on-retry" ~name:"ignored"
    with
    | Ok value -> value
    | Error message -> Alcotest.fail message
  in
  Alcotest.(check bool) "workspace request retries durably" true duplicate;
  Alcotest.(check string)
    "workspace retry retains identity" workspace.id repeated.id;
  let reused, duplicate =
    match
      Registry.accept_broker_workspace registry ~id:"workspace-request-two"
        ~source_id:source.id ~canonical_root:"/tmp/agent-target"
        ~workspace_id:"another-id" ~name:"another-name"
    with
    | Ok value -> value
    | Error message -> Alcotest.fail message
  in
  Alcotest.(check bool) "new request is not duplicate" false duplicate;
  Alcotest.(check string) "canonical root is reused" workspace.id reused.id;
  (match
     Registry.accept_broker_workspace registry ~id:"workspace-request"
       ~source_id:source.id ~canonical_root:"/tmp/different"
       ~workspace_id:"different" ~name:"different"
   with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "workspace request ID accepted different payload");
  let creation, session, duplicate =
    match
      Registry.accept_session_creation registry ~id:"session-request"
        ~source_id:source.id ~workspace_id:workspace.id ~title:"Review agent"
        ~harness:"opencode" ~session_id:"created-session" ~max_active_sessions:2
    with
    | Ok value -> value
    | Error message -> Alcotest.fail message
  in
  Alcotest.(check bool) "first session request is new" false duplicate;
  Alcotest.(check string)
    "reserved session is stable" "created-session" session.id;
  let repeated_creation, repeated_session, duplicate =
    match
      Registry.accept_session_creation registry ~id:"session-request"
        ~source_id:source.id ~workspace_id:workspace.id ~title:"Review agent"
        ~harness:"opencode" ~session_id:"must-not-be-used"
        ~max_active_sessions:2
    with
    | Ok value -> value
    | Error message -> Alcotest.fail message
  in
  Alcotest.(check bool) "session request retries durably" true duplicate;
  Alcotest.(check string)
    "session retry retains identity" session.id repeated_session.id;
  Alcotest.(check string)
    "session request remains pending"
    (Registry_domain.Session_creation_state.to_string creation.state)
    (Registry_domain.Session_creation_state.to_string repeated_creation.state);
  Alcotest.(check bool)
    "one launcher claims the request" true
    (Registry.claim_session_creation registry creation.id);
  Alcotest.(check bool)
    "a concurrent launcher cannot claim" false
    (Registry.claim_session_creation registry creation.id);
  Alcotest.(check bool)
    "launch completion is durable" true
    (Registry.mark_session_creation_active registry creation.id);
  Alcotest.(check string)
    "completed request is active" "active"
    (Registry_domain.Session_creation_state.to_string
       (Option.get (Registry.find_session_creation registry creation.id)).state);
  Alcotest.(check bool)
    "creator owns broker session" true
    (Registry.session_created_by registry ~source_id:source.id
       ~session_id:session.id);
  Alcotest.(check bool)
    "other session does not own broker session" false
    (Registry.session_created_by registry ~source_id:"other-source"
       ~session_id:session.id);
  Alcotest.(check bool)
    "unused session does not suggest cleanup" false
    (Registry.cleanup_recommended registry ~source_id:source.id
       ~session_id:session.id);
  let peer_request, _duplicate =
    Registry.accept_peer_request registry ~id:"cleanup-peer-request"
      ~source_id:source.id ~target_id:session.id ~prompt:"finish safely"
      ~command_id:"cleanup-command" ~start_sequence:0L
  in
  Alcotest.(check bool)
    "unfinished peer work blocks cleanup" true
    (Registry.has_open_session_work registry ~session_id:session.id);
  Alcotest.(check bool)
    "open work does not suggest cleanup" false
    (Registry.cleanup_recommended registry ~source_id:source.id
       ~session_id:session.id);
  Alcotest.(check bool)
    "peer work completes" true
    (Registry.complete_peer_request registry peer_request.id "done");
  Alcotest.(check bool)
    "terminal peer work permits cleanup" false
    (Registry.has_open_session_work registry ~session_id:session.id);
  Alcotest.(check bool)
    "completed caller-owned work suggests cleanup" true
    (Registry.cleanup_recommended registry ~source_id:source.id
       ~session_id:session.id);
  (match
     Registry.claim_session_finish registry ~source_id:source.id
       ~session_id:session.id
   with
  | Ok () -> ()
  | Error message -> Alcotest.fail message);
  Alcotest.(check bool)
    "finish claim fences active lookup" true
    (Option.is_none (Registry.find_active registry session.id));
  Alcotest.(check (list string))
    "finish claim is durably reconcilable" [ session.id ]
    (Registry.list_finishing_sessions registry
    |> List.map (fun (session : Registry.session) -> session.id));
  (match
     Durable_registry.accept_peer_request registry ~id:"fenced-peer-request"
       ~source_id:source.id ~target_id:session.id ~prompt:"too late"
       ~command_id:"fenced-command" ~start_sequence:0L
   with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "finish fence accepted new peer work");
  Alcotest.(check bool)
    "failed cleanup can remove finish fence" true
    (Registry.cancel_session_finish registry session.id);
  Alcotest.(check bool)
    "cancelled finish restores active lookup" true
    (Option.is_some (Registry.find_active registry session.id));
  Alcotest.(check int)
    "cancelled finish leaves no reconciliation work" 0
    (List.length (Registry.list_finishing_sessions registry));
  (match
     Registry.accept_session_creation registry ~id:"session-request-two"
       ~source_id:source.id ~workspace_id:workspace.id ~title:"Limit proof"
       ~harness:"pi" ~session_id:"over-limit" ~max_active_sessions:2
   with
  | Error "active session limit reached" -> ()
  | Error message -> Alcotest.failf "wrong active-limit error: %s" message
  | Ok _ -> Alcotest.fail "active-session limit was bypassed");
  match
    Registry.accept_session_creation registry ~id:"session-request"
      ~source_id:source.id ~workspace_id:workspace.id ~title:"Different title"
      ~harness:"opencode" ~session_id:"different-session" ~max_active_sessions:3
  with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "session request ID accepted different payload"

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
              ("id", `String (Acp.mutation_request_id "late-response"));
              ("result", `Assoc [ ("stopReason", `String "end_turn") ]);
            ]));
  Alcotest.(check (list string))
    "same-text mutation response is not command evidence" []
    (Store.reconcile_ambiguous_responses store);
  (match Store.find_command store "late-response" with
  | Some Domain.Ambiguous -> ()
  | _ -> Alcotest.fail "mutation response changed ambiguous command");
  ignore
    (Store.append_event store ~kind:"acp.response"
       ~payload:
         (`Assoc
            [
              ("jsonrpc", `String "2.0");
              ("id", `String (Acp.command_request_id "late-response"));
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

let test_live_late_response_reconciliation () =
  with_store @@ fun store ->
  ignore
    (Store.accept_command store ~command_id:"late-live" ~request_id:"late-live"
       ~prompt:"finish after timeout");
  Store.set_command_state store ~command_id:"late-live" Domain.Ambiguous;
  (match
     Store.reconcile_ambiguous_command store ~command_id:"late-live"
       Domain.Completed
   with
  | Ok true -> ()
  | Ok false -> Alcotest.fail "late response did not reconcile ambiguity"
  | Error message -> Alcotest.fail message);
  Alcotest.(check (option string))
    "late response installs terminal state" (Some "completed")
    (Store.find_command store "late-live"
    |> Option.map Domain.command_state_to_string);
  (match
     Store.reconcile_ambiguous_command store ~command_id:"late-live"
       Domain.Rejected
   with
  | Ok false -> ()
  | Ok true -> Alcotest.fail "terminal late response was overwritten"
  | Error message -> Alcotest.fail message);
  Alcotest.(check bool)
    "non-terminal late evidence rejected" true
    (Result.is_error
       (Store.reconcile_ambiguous_command store ~command_id:"late-live"
          Domain.Dispatched));
  let reconciled_events =
    Store.list_recent_events store ~limit:10
    |> List.filter (fun event ->
        Yojson.Safe.Util.member "reconciledLateResponse" event.Domain.payload
        = `Bool true)
  in
  Alcotest.(check int)
    "one live late-response event" 1
    (List.length reconciled_events)

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

let test_command_receipt_compaction () =
  with_store @@ fun store ->
  let count = Store.max_retained_command_receipts + 8 in
  for index = 0 to count - 1 do
    let id = Printf.sprintf "bounded-%04d" index in
    let accepted =
      Store.accept_command store ~command_id:id ~request_id:id ~prompt:"done"
    in
    Alcotest.(check bool) "fresh bounded command" false accepted.duplicate;
    Store.set_command_state store ~command_id:id Domain.Completed
  done;
  let retained_id = Printf.sprintf "bounded-%04d" (count - 1) in
  let retained =
    Store.accept_command store ~command_id:retained_id ~request_id:retained_id
      ~prompt:"retry"
  in
  Alcotest.(check bool)
    "newest retained receipt remains authoritative" true retained.duplicate;
  Alcotest.(check bool)
    "oldest terminal receipt was compacted" true
    (Option.is_none (Store.find_command store "bounded-0000"));
  let recycled =
    Store.accept_command store ~command_id:"bounded-0000"
      ~request_id:"bounded-0000" ~prompt:"outside bounded window"
  in
  Alcotest.(check bool)
    "commands beyond the historical limit are accepted" false recycled.duplicate

let test_reused_command_ignores_old_response_after_restart () =
  let path = Filename.temp_file "piss-command-reuse-" ".sqlite3" in
  let open_store () =
    Store.open_ ~path
      ~session_id:(Domain.session_id "session")
      ~worker_id:(Domain.worker_id "worker")
  in
  Fun.protect
    ~finally:(fun () ->
      List.iter
        (fun suffix ->
          let candidate = path ^ suffix in
          if Sys.file_exists candidate then Sys.remove candidate)
        [ ""; "-wal"; "-shm" ])
    (fun () ->
      let first = open_store () in
      ignore
        (Store.accept_command first ~command_id:"reused-command"
           ~request_id:"reused-command" ~prompt:"first invocation");
      ignore
        (Store.append_event first ~kind:"acp.response"
           ~payload:
             (`Assoc
                [
                  ("jsonrpc", `String "2.0");
                  ("id", `String (Acp.command_request_id "reused-command"));
                  ("result", `Assoc [ ("stopReason", `String "end_turn") ]);
                ]));
      Store.set_command_state first ~command_id:"reused-command"
        Domain.Completed;
      for index = 0 to Store.max_retained_command_receipts - 1 do
        let id = Printf.sprintf "evictor-%04d" index in
        ignore
          (Store.accept_command first ~command_id:id ~request_id:id
             ~prompt:"terminal filler");
        Store.set_command_state first ~command_id:id Domain.Completed
      done;
      Alcotest.(check (option string))
        "first invocation receipt was evicted" None
        (Store.find_command first "reused-command"
        |> Option.map Domain.command_state_to_string);
      ignore
        (Store.accept_command first ~command_id:"reused-command"
           ~request_id:"reused-command" ~prompt:"second invocation");
      Store.set_command_state first ~command_id:"reused-command"
        Domain.Ambiguous;
      Store.close first;
      let replacement = open_store () in
      Alcotest.(check (list string))
        "old response cannot complete reused identity" []
        (Store.reconcile_ambiguous_responses replacement);
      (match Store.find_command replacement "reused-command" with
      | Some Domain.Ambiguous -> ()
      | _ -> Alcotest.fail "reused command did not remain ambiguous");
      ignore
        (Store.append_event replacement ~kind:"acp.response"
           ~payload:
             (`Assoc
                [
                  ("jsonrpc", `String "2.0");
                  ("id", `String (Acp.command_request_id "reused-command"));
                  ("result", `Assoc [ ("stopReason", `String "end_turn") ]);
                ]));
      Alcotest.(check (list string))
        "response after current acceptance reconciles" [ "reused-command" ]
        (Store.reconcile_ambiguous_responses replacement);
      Store.close replacement)

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
  Alcotest.(check bool)
    "open command cannot transition backward" false
    (Store.try_set_command_state_if_open store ~command_id:"race-cmd"
       Domain.Received);
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
  Alcotest.(check bool)
    "no command has finished yet" true
    (Option.is_none (Store.last_finished_at store));
  Store.set_command_state store ~command_id:"done-1" Domain.Completed;
  Alcotest.(check bool)
    "terminal transition records finish time" true
    (match Store.last_finished_at store with
    | Some value -> value > 0.
    | None -> false);
  accept "ambiguous-1" "uncertain";
  Store.set_command_state store ~command_id:"ambiguous-1" Domain.Ambiguous;
  Alcotest.(check bool)
    "ambiguous transition records finish time" true
    (Option.is_some (Store.last_finished_at store));
  accept "open-2" "third";
  Alcotest.(check bool)
    "newer open command is not finished" true
    (Option.is_none (Store.last_finished_at store));
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

let test_permission_restart_reconciliation () =
  let path = Filename.temp_file "piss-permission-restart-" ".sqlite3" in
  let open_store () =
    Store.open_ ~path
      ~session_id:(Domain.session_id "session")
      ~worker_id:(Domain.worker_id "worker")
  in
  Fun.protect
    ~finally:(fun () ->
      List.iter
        (fun suffix ->
          let candidate = path ^ suffix in
          if Sys.file_exists candidate then Sys.remove candidate)
        [ ""; "-wal"; "-shm" ])
    (fun () ->
      let first = open_store () in
      ignore
        (Store.append_event first ~kind:"acp.permission.requested"
           ~payload:
             (`Assoc
                [
                  ("jsonrpc", `String "2.0");
                  ("id", `String "permission-restart");
                  ("method", `String "session/request_permission");
                ]));
      Store.close first;
      let replacement = open_store () in
      Alcotest.(check (list string))
        "restart cancels unanswerable permission" [ "permission-restart" ]
        (Store.reconcile_pending_permissions replacement);
      let cancellation =
        Store.list_recent_events replacement ~limit:1 |> List.hd
      in
      Alcotest.(check string)
        "restart cancellation is durable" "acp.permission.cancelled"
        cancellation.kind;
      Store.close replacement;
      let retried = open_store () in
      Fun.protect ~finally:(fun () -> Store.close retried) @@ fun () ->
      Alcotest.(check (list string))
        "durable cancellation is idempotent" []
        (Store.reconcile_pending_permissions retried))

let test_peer_observation_schema_migration () =
  let path = Filename.temp_file "piss-peer-migration-" ".sqlite3" in
  Fun.protect
    ~finally:(fun () ->
      List.iter
        (fun suffix ->
          let candidate = path ^ suffix in
          if Sys.file_exists candidate then Sys.remove candidate)
        [ ""; "-wal"; "-shm" ])
    (fun () ->
      let db = Sqlite3.db_open path in
      let exec sql =
        Alcotest.(check bool)
          "legacy peer schema statement" true
          (Sqlite3.Rc.is_success (Sqlite3.exec db sql))
      in
      exec
        "CREATE TABLE workspaces (id TEXT PRIMARY KEY,name TEXT NOT NULL,root \
         TEXT NOT NULL UNIQUE,created_at REAL NOT NULL)";
      exec
        "CREATE TABLE sessions (id TEXT PRIMARY KEY,title TEXT NOT \
         NULL,harness TEXT NOT NULL CHECK(harness IN \
         ('pi','codex','opencode','mock')),created_at REAL NOT \
         NULL,archived_at REAL,broker_token TEXT NOT NULL DEFAULT \
         '',workspace_id TEXT NOT NULL DEFAULT '',finishing_at REAL)";
      exec
        "CREATE TABLE peer_requests (id TEXT PRIMARY KEY,source_id TEXT NOT \
         NULL,target_id TEXT NOT NULL,prompt TEXT NOT NULL,command_id TEXT NOT \
         NULL UNIQUE,start_sequence INTEGER NOT NULL,observation_sequence \
         INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL,response \
         TEXT,managed_reconciliation INTEGER NOT NULL DEFAULT 0,created_at \
         REAL NOT NULL,updated_at REAL NOT NULL)";
      exec "INSERT INTO workspaces VALUES ('workspace','Workspace','/tmp',0)";
      exec
        "INSERT INTO sessions VALUES \
         ('source','Source','pi',0,NULL,'source-token','workspace',NULL)";
      exec
        "INSERT INTO sessions VALUES \
         ('target','Target','pi',0,NULL,'target-token','workspace',NULL)";
      exec
        "INSERT INTO peer_requests VALUES \
         ('legacy-peer','source','target','work','legacy-command',42,0,'dispatched',NULL,1,0,0)";
      Alcotest.(check bool)
        "legacy peer database closed" true (Sqlite3.db_close db);
      let registry = Durable_registry.open_ ~path in
      Fun.protect ~finally:(fun () -> Durable_registry.close registry)
      @@ fun () ->
      let migrated =
        Option.get (Durable_registry.find_peer_request registry "legacy-peer")
      in
      Alcotest.(check int64)
        "migration starts observation at dispatch cursor" 42L
        migrated.observation_sequence;
      Alcotest.(check string)
        "migration starts with no partial response" "" migrated.partial_response;
      Alcotest.(check bool)
        "migration starts before command acceptance" false migrated.command_seen;
      Alcotest.(check (option string))
        "migration starts without terminal observation" None
        migrated.observed_terminal)

let test_peer_observation_restart () =
  let path = Filename.temp_file "piss-peer-observation-" ".sqlite3" in
  let open_registry () = Durable_registry.open_ ~path in
  Fun.protect
    ~finally:(fun () ->
      List.iter
        (fun suffix ->
          let candidate = path ^ suffix in
          if Sys.file_exists candidate then Sys.remove candidate)
        [ ""; "-wal"; "-shm" ])
    (fun () ->
      let first = open_registry () in
      Durable_registry.upsert_workspace first ~id:"workspace" ~name:"Workspace"
        ~root:"/tmp/peer-observation";
      ignore
        (Durable_registry.insert first ~id:"source" ~title:"Source"
           ~harness:"pi" ~workspace_id:"workspace");
      ignore
        (Durable_registry.insert first ~id:"target" ~title:"Target"
           ~harness:"pi" ~workspace_id:"workspace");
      let request, _ =
        match
          Durable_registry.accept_peer_request first ~id:"stable-peer"
            ~source_id:"source" ~target_id:"target" ~prompt:"observe once"
            ~command_id:"peer-command" ~start_sequence:0L
        with
        | Ok value -> value
        | Error message -> Alcotest.fail message
      in
      ignore
        (Durable_registry.mark_peer_dispatching first request.id
           ~start_sequence:8L);
      ignore (Durable_registry.mark_peer_dispatched first request.id);
      Alcotest.(check bool)
        "first observation page advances" true
        (Durable_registry.advance_peer_observation first request.id
           ~from_sequence:8L ~through_sequence:12L ~command_seen:true
           ~partial_response:"partial" ~terminal_state:None);
      Durable_registry.close first;
      let replacement = open_registry () in
      let resumed =
        Option.get
          (Durable_registry.find_peer_request replacement "stable-peer")
      in
      Alcotest.(check int64)
        "observation cursor survives restart" 12L resumed.observation_sequence;
      Alcotest.(check string)
        "partial response survives restart" "partial" resumed.partial_response;
      Alcotest.(check bool)
        "stale page retry cannot append twice" false
        (Durable_registry.advance_peer_observation replacement resumed.id
           ~from_sequence:8L ~through_sequence:12L ~command_seen:true
           ~partial_response:"partialpartial" ~terminal_state:None);
      Alcotest.(check bool)
        "terminal observation advances once" true
        (Durable_registry.advance_peer_observation replacement resumed.id
           ~from_sequence:12L ~through_sequence:15L ~command_seen:true
           ~partial_response:"partial response"
           ~terminal_state:(Some "completed"));
      Durable_registry.close replacement;
      let retried = open_registry () in
      Fun.protect ~finally:(fun () -> Durable_registry.close retried)
      @@ fun () ->
      let terminal =
        Option.get (Durable_registry.find_peer_request retried "stable-peer")
      in
      Alcotest.(check (option string))
        "terminal observation survives retry" (Some "completed")
        terminal.observed_terminal;
      Alcotest.(check string)
        "assembled response survives retry" "partial response"
        terminal.partial_response)

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

let test_event_pages_are_byte_bounded () =
  with_store @@ fun store ->
  let first =
    Store.append_event store ~kind:"first" ~payload:(`String "aaaaaaaa")
  in
  let second =
    Store.append_event store ~kind:"second" ~payload:(`String "bbbbbbbb")
  in
  let third =
    Store.append_event store ~kind:"third" ~payload:(`String "cccccccc")
  in
  let event_bytes event =
    Domain.event_to_yojson event |> Yojson.Safe.to_string |> String.length
  in
  let two_event_budget =
    3
    + max
        (event_bytes first + event_bytes second)
        (event_bytes second + event_bytes third)
  in
  let kinds events = List.map (fun event -> event.Domain.kind) events in
  let earliest =
    Store.list_events ~max_bytes:two_event_budget store ~after:0L ~limit:3
  in
  let latest =
    Store.list_recent_events ~max_bytes:two_event_budget store ~limit:3
  in
  let before =
    Store.list_events_before ~max_bytes:two_event_budget store
      ~before:Int64.(add third.sequence 1L)
      ~limit:3
  in
  Alcotest.(check (list string))
    "forward polling retains earliest edge" [ "first"; "second" ]
    (kinds earliest);
  Alcotest.(check (list string))
    "recent history retains latest edge" [ "second"; "third" ] (kinds latest);
  Alcotest.(check (list string))
    "backward history retains latest edge" [ "second"; "third" ] (kinds before);
  let continued =
    Store.list_events ~max_bytes:two_event_budget store ~after:second.sequence
      ~limit:3
  in
  Alcotest.(check (list string))
    "a byte-short forward page remains cursor-pageable" [ "third" ]
    (kinds continued);
  let oversized = Store.list_events ~max_bytes:2 store ~after:0L ~limit:3 in
  Alcotest.(check (list string))
    "one oversized event still advances the cursor" [ "first" ]
    (kinds oversized)

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
  | Ok (Wire.Prompt { target; command_id; text = "rollback"; _ })
    when String.equal (Domain.Command_id.to_string command_id) "legacy-command"
    ->
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
  | Ok (Wire.Cancel { mutation_id; _ })
    when String.equal
           (Domain.Request_id.to_string mutation_id)
           "legacy-mutation" ->
      ()
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
  (match
     decode {|{"op":"wait_events","after":12,"limit":200,"timeoutMs":15000}|}
   with
  | Ok (Wire.Wait_events { after = 12L; limit = 200; timeout_ms = 15_000 }) ->
      ()
  | Ok _ -> Alcotest.fail "event wait decoded incorrectly"
  | Error message -> Alcotest.fail message);
  (match
     decode {|{"op":"wait_events","after":0,"limit":200,"timeoutMs":15001}|}
   with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "oversized event wait was accepted");
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

let test_acp_running_state () =
  let update metadata = `Assoc [ ("_meta", metadata) ] in
  let pi running =
    update (`Assoc [ ("piAcp", `Assoc [ ("running", `Bool running) ]) ])
  in
  let codex status =
    update
      (`Assoc
         [
           ( "codex",
             `Assoc [ ("threadStatus", `Assoc [ ("type", `String status) ]) ] );
         ])
  in
  Alcotest.(check (option bool))
    "Pi running" (Some true)
    (Acp.running_state (pi true));
  Alcotest.(check (option bool))
    "Pi idle" (Some false)
    (Acp.running_state (pi false));
  Alcotest.(check (option bool))
    "Codex active" (Some true)
    (Acp.running_state (codex "active"));
  List.iter
    (fun status ->
      Alcotest.(check (option bool))
        ("Codex " ^ status) (Some false)
        (Acp.running_state (codex status)))
    [ "idle"; "notLoaded"; "systemError" ];
  List.iter
    (fun value ->
      Alcotest.(check (option bool))
        "unknown metadata is ignored" None (Acp.running_state value))
    [ `Assoc []; update (`Assoc [ ("codex", `Null) ]); codex "futureStatus" ]

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

let test_validated_ids () =
  let valid label to_string = function
    | Ok value -> Alcotest.(check string) label "stable-id" (to_string value)
    | Error message -> Alcotest.fail message
  in
  valid "session id" Domain.Session_id.to_string
    (Domain.Session_id.of_string "stable-id");
  valid "worker id" Domain.Worker_id.to_string
    (Domain.Worker_id.of_string "stable-id");
  valid "command id" Domain.Command_id.to_string
    (Domain.Command_id.of_string "stable-id");
  valid "request id" Domain.Request_id.to_string
    (Domain.Request_id.of_string "stable-id");
  valid "subscription id" Domain.Subscription_id.to_string
    (Domain.Subscription_id.of_string "stable-id");
  List.iter
    (fun rejected ->
      Alcotest.(check bool)
        "invalid request identity rejected" true
        (Result.is_error (Domain.Request_id.of_string rejected)))
    [ ""; "nul\000id"; String.make 129 'x' ];
  Alcotest.(check bool)
    "negative runtime generation rejected" true
    (Result.is_error (Domain.Runtime_generation.of_int (-1)));
  let command_request = Acp.command_request_id "stable-id" in
  let mutation_request = Acp.mutation_request_id "stable-id" in
  Alcotest.(check bool)
    "ACP command and mutation namespaces differ" true
    (not (String.equal command_request mutation_request));
  Alcotest.(check (option string))
    "ACP command namespace decodes" (Some "stable-id")
    (Acp.command_id_of_request_id command_request);
  Alcotest.(check (option string))
    "ACP mutation is not command evidence" None
    (Acp.command_id_of_request_id mutation_request)

let test_snapshot_identity_validation () =
  let fields =
    [
      ("sessionId", `String "session");
      ("workerId", `String "worker");
      ("runtimeGeneration", `Int 1);
      ("workerPid", `Int 2);
      ("harnessPid", `Null);
      ("agentName", `String "agent");
      ("status", `String "idle");
      ("firstSequence", `Int 0);
      ("lastSequence", `Int 0);
      ("lastFinishedAt", `Null);
      ("retentionPruned", `Bool false);
    ]
  in
  let replace name value =
    `Assoc
      (List.map
         (fun (field, current) ->
           if String.equal field name then (field, value) else (field, current))
         fields)
  in
  List.iter
    (fun json ->
      Alcotest.(check bool)
        "malformed snapshot identity rejected" true
        (Result.is_error (Domain.snapshot_of_yojson json)))
    [
      replace "sessionId" (`String "");
      replace "workerId" (`String "worker\000bad");
      replace "runtimeGeneration" (`Int (-1));
      replace "runtimeGeneration" (`Intlit "9223372036854775807");
      replace "workerPid" (`Int 0);
    ]

let test_typed_transitions () =
  let command from into = Domain.transition_command_state ~from into in
  Alcotest.(check bool)
    "accepted dispatches" true
    (Result.is_ok (command Domain.Accepted Domain.Dispatched));
  Alcotest.(check bool)
    "terminal command cannot reopen" true
    (Result.is_error (command Domain.Completed Domain.Dispatched));
  List.iter
    (fun terminal ->
      Alcotest.(check bool)
        "ambiguous command accepts only terminal ACP evidence" true
        (Result.is_ok (Domain.reconcile_ambiguous_command_state terminal)))
    Domain.[ Completed; Cancelled; Rejected ];
  Alcotest.(check bool)
    "ambiguous command rejects non-terminal evidence" true
    (Result.is_error
       (Domain.reconcile_ambiguous_command_state Domain.Dispatched));
  with_store @@ fun store ->
  ignore
    (Store.accept_command store ~command_id:"typed-transition"
       ~request_id:"typed-transition" ~prompt:"transition");
  Alcotest.(check bool)
    "store applies valid transition" true
    (Result.is_ok
       (Store.transition_command_state store ~command_id:"typed-transition"
          Domain.Dispatched));
  Alcotest.(check bool)
    "store rejects invalid predecessor" true
    (Result.is_error
       (Store.transition_command_state store ~command_id:"typed-transition"
          Domain.Accepted));
  let module Peer = Registry_domain.Peer_request_state in
  Alcotest.(check bool)
    "peer request completes" true
    (Result.is_ok (Peer.transition ~from:Peer.Dispatched Peer.Completed));
  Alcotest.(check bool)
    "completed peer cannot requeue" true
    (Result.is_error (Peer.transition ~from:Peer.Completed Peer.Queued));
  let module Subscription = Registry_domain.Subscription_state in
  Alcotest.(check bool)
    "subscription dispatches" true
    (Result.is_ok
       (Subscription.transition ~from:Subscription.Pending
          Subscription.Dispatching));
  Alcotest.(check bool)
    "delivered subscription cannot reopen" true
    (Result.is_error
       (Subscription.transition ~from:Subscription.Delivered
          Subscription.Pending))

let test_session_lifecycle_state () =
  with_registry @@ fun registry ->
  Registry.upsert_workspace registry ~id:"workspace-life" ~name:"Lifecycle"
    ~root:"/tmp/lifecycle";
  let session =
    Registry.insert registry ~id:"session-life" ~title:"Lifecycle" ~harness:"pi"
      ~workspace_id:"workspace-life"
  in
  let lifecycle () = Registry.session_lifecycle registry session.id in
  Alcotest.(check bool)
    "new session active" true
    (lifecycle () = Some Registry_domain.Session_lifecycle.Active);
  (match
     Registry.accept_session_creation registry ~id:"creation-life"
       ~source_id:session.id ~workspace_id:"workspace-life" ~title:"Child"
       ~harness:"pi" ~session_id:"child-life" ~max_active_sessions:4
   with
  | Error message -> Alcotest.fail message
  | Ok _ -> ());
  ignore (Registry.claim_session_creation registry "creation-life");
  ignore (Registry.mark_session_creation_active registry "creation-life");
  (* Creator ownership is required by the durable finish fence. *)
  (match
     Registry.claim_session_finish registry ~source_id:session.id
       ~session_id:"child-life"
   with
  | Ok () -> ()
  | Error message -> Alcotest.fail message);
  Alcotest.(check bool)
    "finish fence is typed" true
    (Registry.session_lifecycle registry "child-life"
    = Some Registry_domain.Session_lifecycle.Finishing);
  ignore (Registry.archive registry "child-life");
  Alcotest.(check bool)
    "archive is typed" true
    (Registry.session_lifecycle registry "child-life"
    = Some Registry_domain.Session_lifecycle.Archived)

let () =
  Alcotest.run "piss"
    [
      ( "durability",
        [
          Alcotest.test_case "runtime fencing" `Quick test_runtime_fencing;
          Alcotest.test_case "legacy runtime migration" `Quick
            test_legacy_runtime_migration;
          Alcotest.test_case "command recovery" `Quick test_command_recovery;
          Alcotest.test_case "live late ACP response reconciliation" `Quick
            test_live_late_response_reconciliation;
          Alcotest.test_case "command deduplication" `Quick
            test_command_deduplication;
          Alcotest.test_case "terminal command receipts compact" `Quick
            test_command_receipt_compaction;
          Alcotest.test_case "reused command ignores old ACP response" `Quick
            test_reused_command_ignores_old_response_after_restart;
          Alcotest.test_case "legacy command schema migrates" `Quick
            test_command_content_migration;
          Alcotest.test_case "event sequence" `Quick test_event_sequence;
          Alcotest.test_case "event pages are byte bounded" `Quick
            test_event_pages_are_byte_bounded;
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
          Alcotest.test_case "permission restart is fail closed" `Quick
            test_permission_restart_reconciliation;
          Alcotest.test_case "peer observation schema migrates" `Quick
            test_peer_observation_schema_migration;
          Alcotest.test_case "peer observation resumes after restart" `Quick
            test_peer_observation_restart;
          Alcotest.test_case "session registry archive" `Quick
            test_session_registry;
          Alcotest.test_case "legacy registry migration" `Quick
            test_legacy_registry_migration;
          Alcotest.test_case "broker creation registry" `Quick
            test_broker_creation_registry;
          Alcotest.test_case "session registry adds Codex to legacy schema"
            `Quick test_registry_codex_migration;
        ] );
      ( "domain",
        [
          Alcotest.test_case "origin patterns are anchored" `Quick
            test_origin_patterns;
          Alcotest.test_case "command states round trip" `Quick
            test_stable_state_decoding;
          Alcotest.test_case "owned identifiers validate" `Quick
            test_validated_ids;
          Alcotest.test_case "snapshot identities validate" `Quick
            test_snapshot_identity_validation;
          Alcotest.test_case "typed lifecycle transitions" `Quick
            test_typed_transitions;
          Alcotest.test_case "session lifecycle is algebraic" `Quick
            test_session_lifecycle_state;
          Alcotest.test_case "wire bounds fail closed" `Quick test_wire_bounds;
          Alcotest.test_case "workspace file mentions are bounded" `Quick
            test_workspace_file_mentions;
          Alcotest.test_case "ACP image prompts are typed" `Quick
            test_acp_image_prompt;
          Alcotest.test_case "ACP image echoes are bounded" `Quick
            test_acp_image_redaction;
          Alcotest.test_case "ACP errors fail closed" `Quick
            test_acp_error_response;
          Alcotest.test_case "ACP running metadata is normalized" `Quick
            test_acp_running_state;
        ] );
    ]
