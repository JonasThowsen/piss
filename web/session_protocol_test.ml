open! Core

let fail message = raise_s [%message message]

let decode body =
  match Event_history.decode body with
  | Ok entries -> entries
  | Error message -> fail message

let history =
  {|
  [
    {
      "sequence": 1,
      "kind": "command.accepted",
      "payload": {
        "commandId": "web-command",
        "requestId": "web-command",
        "action": "prompt",
        "text": "Run the proof",
        "imageCount": 0,
        "images": [],
        "resourceCount": 0,
        "resources": []
      },
      "createdAt": 1723123456.5
    },
    {
      "sequence": 2,
      "kind": "acp.agent_message_chunk",
      "payload": {
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
          "sessionId": "acp-session",
          "update": {
            "sessionUpdate": "agent_message_chunk",
            "messageId": "agent-web-command",
            "content": {"type": "text", "text": "Proof complete"}
          }
        }
      },
      "createdAt": 1723123457
    },
    {
      "sequence": 3,
      "kind": "acp.tool_call",
      "payload": {
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
          "sessionId": "acp-session",
          "update": {
            "sessionUpdate": "tool_call",
            "toolCallId": "tool-web-command",
            "title": "Run tests",
            "kind": "execute",
            "status": "in_progress",
            "rawInput": {"command": "dune runtest"}
          }
        }
      },
      "createdAt": 1723123458
    },
    {
      "sequence": 4,
      "kind": "command.state",
      "payload": {"commandId": "web-command", "state": "completed"},
      "createdAt": 1723123459
    }
  ]
  |}

let permission_requested =
  {|
    {
      "sequence": 5,
      "kind": "acp.permission.requested",
      "payload": {
        "jsonrpc": "2.0",
        "id": "permission-web-command",
        "method": "session/request_permission",
        "params": {
          "sessionId": "acp-session",
          "toolCall": {
            "toolCallId": "tool-web-command",
            "title": "Allow the stability proof",
            "kind": "execute",
            "status": "pending",
            "rawInput": {"command": "mock-proof"}
          },
          "options": [
            {"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
            {"optionId": "reject-once", "name": "Reject", "kind": "reject_once"}
          ]
        }
      },
      "createdAt": 1723123460
    }
  |}

let permission_resolved =
  {|{"sequence":6,"kind":"acp.permission.resolved","payload":{"requestId":"permission-web-command","optionId":"allow-once"},"createdAt":1723123461}|}

let permission_cancelled =
  {|{"sequence":7,"kind":"acp.permission.cancelled","payload":{"requestId":"permission-web-command"},"createdAt":1723123462}|}

let delivery_history =
  {|
  [
    {"sequence":8,"kind":"command.accepted","payload":{"commandId":"follow-command","requestId":"follow-command","action":"follow_up","text":"later","imageCount":1,"images":[{"mimeType":"image/gif","name":"proof.gif","size":14}],"resourceCount":0,"resources":[]},"createdAt":1723123463},
    {"sequence":9,"kind":"command.reconciled","payload":{"commandId":"follow-command","state":"ambiguous","reason":"worker restarted before completion"},"createdAt":1723123464}
  ]
  |}

let null_raw_input kind sequence =
  Printf.sprintf
    {|{"sequence":%d,"kind":"acp.%s","payload":{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"acp-session","update":{"sessionUpdate":"%s","toolCallId":"null-input-tool","title":"edit","kind":"edit","status":"completed","rawInput":null}}},"createdAt":1723123465}|}
    sequence kind kind

let runtime =
  {
    Runtime_domain.session_id = "session";
    worker_id = "worker-incarnation";
    worker_generation = "generation";
    runtime_generation = 7;
    worker_pid = 1;
    harness_pid = Some 2;
    agent_name = "mock";
    status = Idle;
    first_sequence = 0L;
    last_sequence = 0L;
    retention_pruned = false;
    upgrade_pending = false;
    accepts_images = true;
    config_options = [];
    available_commands = [];
  }

let () =
  let entries = decode history in
  let history_events =
    match Event_history.decode_events history with
    | Ok events -> events
    | Error message -> fail message
  in
  if Event_history.has_conversation_boundary history_events then
    fail "history stopped paging without a prior completed conversation";
  let sample = List.hd_exn history_events in
  let at_budget =
    List.init Event_history.max_initial_recovery_events ~f:(fun _ -> sample)
  in
  if Event_history.initial_recovery_can_request_more at_budget then
    fail "initial history requested a zero-sized page at its work budget";
  (match Event_history.initial_recovery_budget at_budget with
  | Capped -> ()
  | Complete | Fetch_more _ -> fail "history cap did not return pageable data");
  let below_budget = List.tl_exn at_budget in
  if not (Event_history.initial_recovery_can_request_more below_budget) then
    fail "initial history stopped before its documented work budget";
  (match Event_history.initial_recovery_budget below_budget with
  | Fetch_more 1 -> ()
  | Complete | Capped | Fetch_more _ ->
      fail "history recovery did not clamp its final page to the work budget");
  let orphaned_boundary_events =
    match
      Event_history.decode_events
        {|[
          {"sequence":1,"kind":"command.state","payload":{"commandId":"previous","state":"completed"},"createdAt":1},
          {"sequence":2,"kind":"command.accepted","payload":{"commandId":"current","requestId":"current","action":"prompt","text":"next","imageCount":0,"images":[],"resourceCount":0,"resources":[]},"createdAt":2}
        ]|}
    with
    | Ok events -> events
    | Error message -> fail message
  in
  if Event_history.has_conversation_boundary orphaned_boundary_events then
    fail "orphaned terminal state stopped paging before its prompt was loaded";
  let boundary_events =
    match
      Event_history.decode_events
        {|[
          {"sequence":1,"kind":"command.accepted","payload":{"commandId":"previous","requestId":"previous","action":"prompt","text":"before","imageCount":0,"images":[],"resourceCount":0,"resources":[]},"createdAt":1},
          {"sequence":2,"kind":"command.state","payload":{"commandId":"previous","state":"completed"},"createdAt":2},
          {"sequence":3,"kind":"command.accepted","payload":{"commandId":"current","requestId":"current","action":"prompt","text":"next","imageCount":0,"images":[],"resourceCount":0,"resources":[]},"createdAt":3}
        ]|}
    with
    | Ok events -> events
    | Error message -> fail message
  in
  if not (Event_history.has_conversation_boundary boundary_events) then
    fail "complete conversation boundary did not stop initial paging";
  let recovery_without_acceptance =
    match
      Event_history.decode_events
        {|[
          {"sequence":1,"kind":"command.state","payload":{"commandId":"previous","state":"completed"},"createdAt":1},
          {"sequence":2,"kind":"command.accepted","payload":{"commandId":"current","requestId":"current","action":"prompt","text":"next","imageCount":0,"images":[],"resourceCount":0,"resources":[]},"createdAt":2},
          {"sequence":3,"kind":"command.recovered","payload":{"commandId":"older-recovery","action":"follow_up","reason":"operator recovery"},"createdAt":3}
        ]|}
    with
    | Ok events -> events
    | Error message -> fail message
  in
  if Event_history.initial_history_is_complete recovery_without_acceptance then
    fail "history stopped before a recovered command acceptance was loaded";
  let complete_recovery_history =
    match
      Event_history.decode_events
        {|[
          {"sequence":1,"kind":"command.accepted","payload":{"commandId":"older-recovery","requestId":"older-recovery","action":"follow_up","text":"restored","imageCount":0,"images":[],"resourceCount":0,"resources":[]},"createdAt":1},
          {"sequence":2,"kind":"command.state","payload":{"commandId":"older-recovery","state":"completed"},"createdAt":2},
          {"sequence":3,"kind":"command.accepted","payload":{"commandId":"current","requestId":"current","action":"prompt","text":"next","imageCount":0,"images":[],"resourceCount":0,"resources":[]},"createdAt":3},
          {"sequence":4,"kind":"command.recovered","payload":{"commandId":"older-recovery","action":"follow_up","reason":"operator recovery"},"createdAt":4}
        ]|}
    with
    | Ok events -> events
    | Error message -> fail message
  in
  if not (Event_history.initial_history_is_complete complete_recovery_history)
  then fail "history did not stop after recovered acceptance was loaded";
  (match Event_history.project complete_recovery_history with
  | User { command_id = "older-recovery"; text = "restored"; _ }
    :: Command_state _
    :: User { command_id = "current"; _ }
    :: _ ->
      ()
  | _ -> fail "resolved recovery did not restore its durable prompt text");
  (match entries with
  | [
   Event_history.User { text = "Run the proof"; _ };
   Agent { text = "Proof complete"; _ };
   Tool { input = "dune runtest"; output = ""; status = "in_progress"; _ };
   Command_state { state = Completed; _ };
  ] ->
      ()
  | _ -> fail "decoded history did not preserve typed timeline entries");
  List.iter [ "tool_call"; "tool_call_update" ] ~f:(fun kind ->
      match Event_history.decode_event (null_raw_input kind 10) with
      | Ok _ -> ()
      | Error message -> fail ("null rawInput was rejected: " ^ message));
  let malformed_raw_input =
    null_raw_input "tool_call" 10
    |> String.substr_replace_first ~pattern:"\"rawInput\":null"
         ~with_:"\"rawInput\":\"edit\""
  in
  (match Event_history.decode_event malformed_raw_input with
  | Error message when String.is_substring message ~substring:"rawInput" -> ()
  | _ -> fail "non-object rawInput did not fail closed");
  if not (Event_history.command_is_terminal ~command_id:"web-command" entries)
  then fail "completed command was not terminal";
  let malformed =
    String.substr_replace_first history ~pattern:"\"state\": \"completed\""
      ~with_:"\"state\": \"mystery\""
  in
  (match Event_history.decode malformed with
  | Error message when String.is_substring message ~substring:"unsupported" ->
      ()
  | _ -> fail "unsupported command state was accepted");
  let idless_message =
    String.substr_replace_first history
      ~pattern:"\"messageId\": \"agent-web-command\"," ~with_:""
  in
  (match decode idless_message with
  | [ User _; Agent { text = "Proof complete"; _ }; Tool _; Command_state _ ] ->
      ()
  | _ -> fail "agent message without an ACP messageId was not retained");
  let load_replay =
    {|
    [
      {"sequence":1,"kind":"command.accepted","payload":{"commandId":"old-command","requestId":"old-command","action":"prompt","text":"Original prompt","imageCount":0,"images":[],"resourceCount":0,"resources":[]},"createdAt":1},
      {"sequence":2,"kind":"acp.agent_message_chunk","payload":{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"acp-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Original answer"}}}},"createdAt":2},
      {"sequence":3,"kind":"acp.initialize","payload":{},"createdAt":3},
      {"sequence":4,"kind":"acp.agent_message_chunk","payload":{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"acp-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Original answer"}}}},"createdAt":4},
      {"sequence":5,"kind":"acp.user_message_chunk","payload":{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"acp-session","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Original prompt"}}}},"createdAt":5},
      {"sequence":6,"kind":"acp.agent_message_chunk","payload":{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"acp-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Another old answer"}}}},"createdAt":6},
      {"sequence":7,"kind":"acp.session.loaded","payload":{},"createdAt":7},
      {"sequence":8,"kind":"command.accepted","payload":{"commandId":"new-command","requestId":"new-command","action":"prompt","text":"New prompt","imageCount":0,"images":[],"resourceCount":0,"resources":[]},"createdAt":8},
      {"sequence":9,"kind":"acp.agent_message_chunk","payload":{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"acp-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"New answer"}}}},"createdAt":9}
    ]
    |}
  in
  (match decode load_replay with
  | [
   User { text = "Original prompt"; _ };
   Agent { text = "Original answer"; _ };
   User { text = "New prompt"; _ };
   Agent { text = "New answer"; _ };
  ] ->
      ()
  | _ -> fail "session/load replay was rendered as fresh conversation output");
  let failed_load_replay =
    String.substr_replace_first load_replay ~pattern:"acp.session.loaded"
      ~with_:"acp.session.load_failed"
  in
  (match decode failed_load_replay with
  | [
   User { text = "Original prompt"; _ };
   Agent { text = "Original answer"; _ };
   User { text = "New prompt"; _ };
   Agent { text = "New answer"; _ };
  ] ->
      ()
  | _ -> fail "failed session/load replay was rendered as fresh output");
  let replay_page_prefix =
    load_replay
    |> String.substr_replace_first
         ~pattern:
           {|{"sequence":1,"kind":"command.accepted","payload":{"commandId":"old-command","requestId":"old-command","action":"prompt","text":"Original prompt","imageCount":0,"images":[],"resourceCount":0,"resources":[]},"createdAt":1},
      {"sequence":2,"kind":"acp.agent_message_chunk","payload":{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"acp-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Original answer"}}}},"createdAt":2},
      {"sequence":3,"kind":"acp.initialize","payload":{},"createdAt":3},
      |}
         ~with_:""
  in
  (match decode replay_page_prefix with
  | [ User { text = "New prompt"; _ }; Agent { text = "New answer"; _ } ] -> ()
  | _ -> fail "recent page beginning inside session/load replay was not cleaned");
  let out_of_order =
    String.substr_replace_first history ~pattern:"\"sequence\": 4"
      ~with_:"\"sequence\": 2"
  in
  (match Event_history.decode out_of_order with
  | Error message when String.is_substring message ~substring:"increasing" -> ()
  | _ -> fail "out-of-order event history was accepted");
  let command =
    match
      Prompt_command.prompt ~runtime ~command_id:"web-uuid" ~text:"plain text"
        ~images:[]
        ~resources:[ { path = "web/main.ml" } ]
    with
    | Ok command -> command
    | Error message -> fail message
  in
  let expected =
    Yojson.Safe.from_string
      {|{"target":{"sessionId":"session","workerId":"worker-incarnation","runtimeGeneration":7},"commandId":"web-uuid","text":"plain text","images":[],"resources":[{"path":"web/main.ml"}],"action":"prompt"}|}
  in
  if not (Yojson.Safe.equal expected (Prompt_command.to_yojson command)) then
    fail "prompt encoder emitted the wrong wire contract";
  let upgrade_event =
    Event_history.decode_event
      {|{"sequence":5,"kind":"worker.upgrade.completed","payload":{},"createdAt":4.0}|}
  in
  (match upgrade_event with
  | Ok event when Event_history.refreshes_session event -> ()
  | _ -> fail "worker upgrade completion did not refresh the runtime");
  (match
     Event_history.decode_event
       {|{"sequence":6,"kind":"acp.available_commands_update","payload":{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"acp-session","update":{"sessionUpdate":"available_commands_update","availableCommands":[]}}},"createdAt":5}|}
   with
  | Ok event when Event_history.refreshes_session event -> ()
  | _ -> fail "available commands did not refresh the runtime snapshot");
  (match
     Prompt_command.prompt ~runtime ~command_id:"web-uuid" ~text:"   "
       ~images:[] ~resources:[]
   with
  | Error _ -> ()
  | Ok _ -> fail "blank prompt was accepted");
  let requested =
    match Event_history.decode_event permission_requested with
    | Ok event -> event
    | Error message -> fail message
  in
  let codex_permission =
    permission_requested
    |> String.substr_replace_first ~pattern:"\"id\": \"permission-web-command\""
         ~with_:"\"id\": 0"
    |> String.substr_replace_first
         ~pattern:"            \"title\": \"Allow the stability proof\",\n"
         ~with_:""
  in
  (match
     Event_history.decode_event codex_permission
     |> Result.map ~f:(fun event ->
         Event_history.project [ event ] |> Event_history.pending_permissions)
   with
  | Ok
      [
        {
          request =
            {
              request_id = "0";
              tool =
                { title = "execute"; kind = "execute"; status = "pending"; _ };
              _;
            };
          _;
        };
      ] ->
      ()
  | Error message -> fail message
  | Ok _ -> fail "Codex titleless permission request was not projected");
  let replay_boundary sequence kind =
    match
      Event_history.decode_event
        (Printf.sprintf
           {|{"sequence":%d,"kind":"%s","payload":{},"createdAt":4.0}|} sequence
           kind)
    with
    | Ok event -> event
    | Error message -> fail message
  in
  let replay_with_permission =
    [
      replay_boundary 1 "acp.initialize";
      requested;
      replay_boundary 100 "acp.session.loaded";
    ]
    |> Event_history.project |> Event_history.pending_permissions
  in
  if List.is_empty replay_with_permission then
    fail "session-load filtering discarded an authoritative permission";
  let resolved =
    match Event_history.decode_event permission_resolved with
    | Ok event -> event
    | Error message -> fail message
  in
  let cancelled =
    match Event_history.decode_event permission_cancelled with
    | Ok event -> event
    | Error message -> fail message
  in
  (match
     Event_history.pending_permissions (Event_history.project [ requested ])
   with
  | [
   { request = { request_id = "permission-web-command"; tool; options; _ }; _ };
  ]
    when String.equal tool.tool_call_id "tool-web-command"
         && List.equal String.equal
              (List.map options ~f:(fun option -> option.option_id))
              [ "allow-once"; "reject-once" ] ->
      ()
  | _ -> fail "permission request fixture was not projected exactly");
  if
    not
      (List.is_empty
         (Event_history.pending_permissions
            (Event_history.project [ requested; resolved ])))
  then fail "resolved permission remained pending";
  (match Event_history.project [ resolved ] with
  | [ Permission_resolved { option_id = Some "allow-once"; _ } ] -> ()
  | _ -> fail "resolved permission fixture lost its selected option");
  (match Event_history.project [ cancelled ] with
  | [ Permission_cancelled { request_id = "permission-web-command"; _ } ] -> ()
  | _ -> fail "cancelled permission fixture was not decoded");
  if
    not
      (List.is_empty
         (Event_history.pending_permissions
            (Event_history.project [ requested; cancelled ])))
  then fail "cancelled permission remained pending";
  let malformed_permission =
    String.substr_replace_first permission_requested
      ~pattern:", \"kind\": \"allow_once\"" ~with_:""
  in
  (match Event_history.decode_event malformed_permission with
  | Error message when String.is_substring message ~substring:"kind" -> ()
  | _ -> fail "permission option without a kind was accepted");
  let decision =
    Permission_decision.to_yojson runtime ~mutation_id:"decision-one"
      ~request_id:"permission-web-command" ~option_id:(Some "allow-once")
  in
  if
    not
      (Yojson.Safe.equal decision
         (`Assoc
            [
              ("target", Runtime_domain.target_to_yojson runtime);
              ("mutationId", `String "decision-one");
              ("requestId", `String "permission-web-command");
              ("optionId", `String "allow-once");
            ]))
  then fail "selected permission decision JSON was incorrect";
  let cancelled_decision =
    Permission_decision.to_yojson runtime ~mutation_id:"decision-cancel"
      ~request_id:"permission-web-command" ~option_id:None
  in
  if
    not
      (Yojson.Safe.equal cancelled_decision
         (`Assoc
            [
              ("target", Runtime_domain.target_to_yojson runtime);
              ("mutationId", `String "decision-cancel");
              ("requestId", `String "permission-web-command");
              ("optionId", `Null);
            ]))
  then fail "cancel permission decision JSON was incorrect";
  let delivery_events =
    match Event_history.decode_events delivery_history with
    | Ok events -> events
    | Error message -> fail message
  in
  (match
     delivery_events
     |> List.filter_map ~f:Event_history.outbox_update
     |> Outbox_projection.project
   with
  | [
   { command_id = "follow-command"; action = Follow_up; status = Ambiguous; _ };
  ] ->
      ()
  | _ ->
      fail "accepted/reconciled events did not project an ambiguous follow-up");
  (match Event_history.project delivery_events with
  | [ User { text = "later"; _ }; Command_state { state = Ambiguous; _ } ] -> ()
  | _ -> fail "image metadata changed the text-only timeline projection");
  (match
     Request_target.same_origin ~path:"/api/v2/events"
       ~query:[ ("recent", "500"); ("session", "session/a & b") ]
   with
  | Ok target
    when String.equal target
           "/api/v2/events?recent=500&session=session%2Fa%20%26%20b" ->
      ()
  | Ok target -> fail ("unexpected encoded target: " ^ target)
  | Error message -> fail message);
  (match
     Request_target.same_origin ~path:"/api/v2/event-stream"
       ~query:[ ("session", "session/a & b"); ("after", "42") ]
   with
  | Ok target
    when String.equal target
           "/api/v2/event-stream?session=session%2Fa%20%26%20b&after=42" ->
      ()
  | Ok target -> fail ("unexpected stream target: " ^ target)
  | Error message -> fail message);
  match Request_target.same_origin ~path:"//example.test/events" ~query:[] with
  | Error _ -> ()
  | Ok _ -> fail "network-path reference was accepted"
