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

let () =
  let entries = decode history in
  (match entries with
  | [
   Event_history.User { text = "Run the proof"; _ };
   Agent { text = "Proof complete"; _ };
   Tool { detail = "dune runtest"; status = "in_progress"; _ };
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
    match Prompt_command.prompt ~command_id:"web-uuid" ~text:"plain text" with
    | Ok command -> command
    | Error message -> fail message
  in
  let expected =
    Yojson.Safe.from_string
      {|{"commandId":"web-uuid","text":"plain text","images":[],"resources":[],"action":"prompt"}|}
  in
  if not (Yojson.Safe.equal expected (Prompt_command.to_yojson command)) then
    fail "prompt encoder emitted the wrong wire contract";
  (match Prompt_command.prompt ~command_id:"web-uuid" ~text:"   " with
  | Error _ -> ()
  | Ok _ -> fail "blank prompt was accepted");
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
  match Request_target.same_origin ~path:"//example.test/events" ~query:[] with
  | Error _ -> ()
  | Ok _ -> fail "network-path reference was accepted"
