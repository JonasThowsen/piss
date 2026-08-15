open! Core

let fail message = raise_s [%message message]

let workspace id name root : Workspace_catalog.workspace =
  { id; name; root; created_at = 1. }

let session ?(status = Control_plane.Session.Idle) ?archived_at
    ?last_finished_at id title harness workspace_id : Control_plane.Session.t =
  {
    id;
    title;
    harness;
    workspace_id;
    created_at = 1.;
    archived_at;
    last_finished_at;
    status;
    runtime = None;
  }

let expect_error result substring =
  match result with
  | Error message when String.is_substring message ~substring -> ()
  | Error message -> fail ("unexpected decoder error: " ^ message)
  | Ok _ -> fail ("decoder accepted invalid " ^ substring)

let () =
  let workspaces =
    [
      workspace "w-a" "Compiler" "/srv/compiler";
      workspace "w-b" "Docs" "/srv/docs";
    ]
  in
  let active =
    [
      session "s-z" "zebra" Mock "w-b";
      session ~last_finished_at:20. "s-finished-new" "Newest result" Pi "w-b";
      session ~last_finished_at:10. "s-finished-old" "Older result" Pi "w-a";
      session ~status:Running "s-run-b" "Live docs" Pi "w-b";
      session ~status:Failed "s-finish-a" "Compiler crash" Pi "w-a";
      session ~status:Requires_action "s-attention-b" "Needs input" Pi "w-b";
      session "s-a" "Alpha" Opencode "w-a";
      session ~status:Offline "s-offline-a" "Alpha" Mock "w-a";
      session ~status:Starting "s-run-a" "Boot compiler" Pi "w-a";
      session ~status:Stopped "s-finish-b" "Docs complete" Pi "w-b";
      session "s-b" "alpha" Pi "w-b";
    ]
  and archived =
    [
      session ~status:Archived ~archived_at:2. "s-archived-b" "Alpha archive" Pi
        "w-b";
      session ~status:Archived ~archived_at:2. "s-old" "Retired proof" Pi "w-a";
    ]
  in
  let all =
    Global_search.items ~scope:Active ~query:"" ~workspaces ~active ~archived
  in
  if
    not
      (List.equal String.equal
         (List.map all ~f:(fun item -> item.Global_search.session.id))
         [
           "s-finished-new";
           "s-finished-old";
           "s-finish-a";
           "s-finish-b";
           "s-attention-b";
           "s-run-a";
           "s-run-b";
           "s-a";
           "s-offline-a";
           "s-b";
           "s-z";
         ])
  then fail "active search did not prioritize newly finished sessions";
  let newest = List.hd_exn all in
  if not (String.equal (Global_search.status_label newest.session) "finished")
  then fail "completed idle session was not labeled finished";
  let by_workspace =
    Global_search.items ~scope:Active ~query:"compiler OPENCODE" ~workspaces
      ~active ~archived
  in
  (match by_workspace with
  | [ item ] when String.equal item.session.id "s-a" -> ()
  | _ -> fail "search did not span workspace and harness fields");
  let archived_result =
    Global_search.items ~scope:Archived ~query:"archived s-old" ~workspaces
      ~active ~archived
  in
  if List.length archived_result <> 1 then
    fail "archived scope was not searched";
  let all_archived =
    Global_search.items ~scope:Archived ~query:"" ~workspaces ~active ~archived
  in
  if
    not
      (List.equal String.equal
         (List.map all_archived ~f:(fun item -> item.Global_search.session.id))
         [ "s-old"; "s-archived-b" ])
  then fail "archived search was not grouped by workspace";
  if Global_search.move ~count:3 ~current:0 ~delta:(-1) <> 2 then
    fail "keyboard selection did not wrap backward";
  (match
     Control_plane.decode_session_creation
       {|{"availableHarnesses":["pi","opencode","mock"],"defaultHarness":"pi"}|}
   with
  | Ok { available_harnesses = [ Pi; Opencode; Mock ]; default_harness = Pi } ->
      ()
  | Ok _ -> fail "session creation options lost server harness order/default"
  | Error message -> fail message);
  expect_error
    (Control_plane.decode_session_creation
       {|{"availableHarnesses":["mock"],"defaultHarness":"pi"}|})
    "must be available";
  (match
     Control_plane.decode_session_creation
       {|{"availableHarnesses":["pi","pi","mock"],"defaultHarness":"pi"}|}
   with
  | Ok { available_harnesses = [ Pi; Mock ]; default_harness = Pi } -> ()
  | Ok _ -> fail "duplicate server harnesses were not normalized"
  | Error message -> fail message);
  let archived_body =
    {|[{"id":"s-old","title":"Retired proof","harness":"pi","workspaceId":"w-a","createdAt":1,"archivedAt":2,"status":"archived"}]|}
  in
  (match Control_plane.decode_archived_sessions archived_body with
  | Ok [ value ] when String.equal value.id "s-old" -> ()
  | Ok _ -> fail "archived session decoder lost the record"
  | Error message -> fail message);
  expect_error
    (Control_plane.decode_archived_sessions
       {|[{"id":"s-live","title":"Live","harness":"pi","workspaceId":"w-a","createdAt":1,"archivedAt":null,"status":"offline"}]|})
    "must be an archived session";
  (match
     Control_plane.decode_created_session_id
       {|{"id":"s-new","title":"New","harness":"mock","workspaceId":"w-a","createdAt":1,"archivedAt":null}|}
   with
  | Ok "s-new" -> ()
  | Ok _ -> fail "created session decoder returned the wrong id"
  | Error message -> fail message);
  expect_error
    (Control_plane.decode_created_session_id
       {|{"id":"s-new","title":"New","harness":"mock","workspaceId":"w-a","createdAt":1,"archivedAt":2}|})
    "must be null";
  (match
     Workspace_catalog.decode_directories
       {|[{"name":"Compiler","path":"/srv/compiler"}]|}
   with
  | Ok [ directory ] when String.equal directory.path "/srv/compiler" -> ()
  | Ok _ -> fail "directory decoder lost the record"
  | Error message -> fail message);
  expect_error
    (Workspace_catalog.decode_directories
       {|[{"name":"Compiler","path":"relative"}]|})
    "absolute path";
  let target =
    Request_target.path_with_id ~prefix:"/api/v2/sessions/" ~id:"session/a & b"
      ~suffix:"/archive"
  in
  if not (String.equal target "/api/v2/sessions/session%2Fa%20%26%20b/archive")
  then fail ("path identifier was not encoded: " ^ target)
