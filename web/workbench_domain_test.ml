open! Core

let fail message = raise_s [%message message]

let snapshot =
  {|
    {
      "sessionId": "session-a",
      "workerId": "worker-a",
      "workerGeneration": "generation-a",
      "runtimeGeneration": 4,
      "workerPid": 4100,
      "harnessPid": 4101,
      "agentName": "OpenCode",
      "status": "idle",
      "firstSequence": 12,
      "lastSequence": 48,
      "retentionPruned": true,
      "upgradePending": false,
      "acceptsImages": true,
      "configOptions": [
        {
          "type": "select",
          "id": "model",
          "category": "model",
          "name": "Model",
          "currentValue": "mock/fast",
          "options": [
            {"value": "mock/fast", "name": "Mock Fast"},
            {"value": "mock/deep", "name": "Mock Deep", "description": "Slower"}
          ]
        },
        {
          "type": "select",
          "id": "thought_level",
          "category": "thought_level",
          "name": "Thinking",
          "currentValue": "medium",
          "options": [
            {"value": "off", "name": "off"},
            {"value": "medium", "name": "medium"}
          ]
        }
      ]
    }
  |}

let decode_snapshot body =
  match Runtime_domain.decode ~expected_session:"session-a" body with
  | Ok value -> value
  | Error message -> fail message

let expect_error result substring =
  match result with
  | Error message when String.is_substring message ~substring -> ()
  | Error message -> fail ("unexpected decoder error: " ^ message)
  | Ok _ -> fail ("decoder accepted invalid " ^ substring)

let session id workspace_id : Control_plane.Session.t =
  {
    id;
    title = id;
    harness = Mock;
    workspace_id;
    created_at = 1.;
    archived_at = None;
    status = Idle;
    runtime = None;
  }

let () =
  let runtime = decode_snapshot snapshot in
  if not runtime.accepts_images then fail "image capability was lost";
  if not runtime.retention_pruned then fail "retention flag was lost";
  (match Runtime_domain.find_category runtime "model" with
  | Some option when String.equal option.current_value "mock/fast" -> ()
  | _ -> fail "model config category was not decoded");
  snapshot
  |> String.substr_replace_first ~pattern:"session-a" ~with_:"session-b"
  |> Runtime_domain.decode ~expected_session:"session-a"
  |> Fn.flip expect_error "must match id";
  snapshot
  |> String.substr_replace_first ~pattern:"\"lastSequence\": 48"
       ~with_:"\"lastSequence\": 2"
  |> Runtime_domain.decode ~expected_session:"session-a"
  |> Fn.flip expect_error "invalid retained sequence";
  snapshot
  |> String.substr_replace_first ~pattern:"\"currentValue\": \"mock/fast\""
       ~with_:"\"currentValue\": \"missing\""
  |> Runtime_domain.decode ~expected_session:"session-a"
  |> Fn.flip expect_error "must match an option value";
  let workspaces =
    match
      Workspace_catalog.decode
        {|[{"id":"one","name":"One","root":"/srv/one","createdAt":1},{"id":"two","name":"Two","root":"/srv/two","createdAt":2}]|}
    with
    | Ok values -> values
    | Error message -> fail message
  in
  expect_error
    (Workspace_catalog.decode
       {|[{"id":"one","name":"One","root":"relative","createdAt":1}]|})
    "absolute path";
  let sessions = [ session "a" "one"; session "b" "two" ] in
  let groups = Workspace_catalog.group workspaces sessions in
  if List.length groups <> 2 then fail "workspace grouping changed cardinality";
  if
    not
      (Option.equal String.equal
         (Workspace_catalog.reconcile_selection ~previous:(Some "b") sessions)
         (Some "b"))
  then fail "catalog refresh did not preserve selection";
  if
    not
      (phys_equal
         (Session_tabs.select_after_snapshot ~previous:(Some Idle) ~next:Running
            Agent)
         Working)
  then fail "new run did not switch Agent to Working";
  if
    not
      (phys_equal
         (Session_tabs.select_after_snapshot ~previous:(Some Idle) ~next:Running
            Details)
         Details)
  then fail "new run displaced Details";
  let entries =
    [
      Event_history.Tool
        {
          sequence = 1L;
          tool_call_id = "tool-one";
          title = "Build";
          input = "dune build";
          output = "";
          status = "in_progress";
          artifacts = [];
        };
      Event_history.Tool
        {
          sequence = 2L;
          tool_call_id = "tool-two";
          title = "Test";
          input = "dune runtest";
          output = "ok";
          status = "completed";
          artifacts = [];
        };
    ]
  in
  let working =
    Working_view.derive
      ~snapshot:(Some { runtime with status = Running })
      ~connecting:false ~events:[] ~entries
  in
  if not (phys_equal working.phase Running_tool) then
    fail "running tool was not projected";
  if List.length working.recent <> 1 then fail "recent tools were not projected";
  let awaiting =
    Working_view.derive
      ~snapshot:(Some { runtime with status = Requires_action })
      ~connecting:false ~events:[] ~entries:[]
  in
  if not (phys_equal awaiting.phase Awaiting_permission) then
    fail "permission status was not projected"
