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

let () =
  let entries = decode history in
  (match entries with
  | [
   Event_history.User { text = "Run the proof"; _ };
   Agent { text = "Proof complete"; _ };
   Tool { input = "dune runtest"; output = ""; status = "in_progress"; _ };
   Command_state { state = Completed; _ };
  ] ->
      ()
  | _ -> fail "decoded history did not preserve typed timeline entries");
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
  let out_of_order =
    String.substr_replace_first history ~pattern:"\"sequence\": 4"
      ~with_:"\"sequence\": 2"
  in
  (match Event_history.decode out_of_order with
  | Error message when String.is_substring message ~substring:"increasing" -> ()
  | _ -> fail "out-of-order event history was accepted");
  let command =
    match
      Prompt_command.prompt ~command_id:"web-uuid" ~text:"plain text"
        ~resources:[ { path = "web/App.re" } ]
    with
    | Ok command -> command
    | Error message -> fail message
  in
  let expected =
    Yojson.Safe.from_string
      {|{"commandId":"web-uuid","text":"plain text","images":[],"resources":[{"path":"web/App.re"}],"action":"prompt"}|}
  in
  if not (Yojson.Safe.equal expected (Prompt_command.to_yojson command)) then
    fail "prompt encoder emitted the wrong wire contract";
  (match
     Prompt_command.prompt ~command_id:"web-uuid" ~text:"   " ~resources:[]
   with
  | Error _ -> ()
  | Ok _ -> fail "blank prompt was accepted");
  let requested =
    match Event_history.decode_event permission_requested with
    | Ok event -> event
    | Error message -> fail message
  in
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
    Permission_decision.to_yojson ~request_id:"permission-web-command"
      ~option_id:(Some "allow-once")
  in
  if
    not
      (Yojson.Safe.equal decision
         (`Assoc
            [
              ("requestId", `String "permission-web-command");
              ("optionId", `String "allow-once");
            ]))
  then fail "selected permission decision JSON was incorrect";
  let cancelled_decision =
    Permission_decision.to_yojson ~request_id:"permission-web-command"
      ~option_id:None
  in
  if
    not
      (Yojson.Safe.equal cancelled_decision
         (`Assoc
            [
              ("requestId", `String "permission-web-command");
              ("optionId", `Null);
            ]))
  then fail "cancel permission decision JSON was incorrect";
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
