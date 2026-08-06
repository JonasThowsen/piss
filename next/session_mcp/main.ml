let read_channel channel =
  let buffer = Buffer.create 4096 in
  let bytes = Bytes.create 4096 in
  let rec loop () =
    match input channel bytes 0 (Bytes.length bytes) with
    | 0 -> Buffer.contents buffer
    | count ->
        Buffer.add_subbytes buffer bytes 0 count;
        loop ()
  in
  loop ()

let required_env name =
  match Sys.getenv_opt name with
  | Some value when value <> "" -> value
  | _ -> failwith (name ^ " is required")

let broker_url = required_env "PISS_BROKER_URL"
let broker_token = required_env "PISS_SESSION_TOKEN"
let curl_command = required_env "PISS_CURL"

exception Broker_unavailable of string

let split_http_response output =
  match String.rindex_opt output '\n' with
  | None -> raise (Broker_unavailable "broker returned no HTTP status")
  | Some index ->
      let body = String.sub output 0 index in
      let status =
        String.sub output (index + 1) (String.length output - index - 1)
        |> int_of_string_opt
      in
      (body, status)

let curl ?body path =
  let url = broker_url ^ path in
  let base =
    [
      curl_command;
      "-sS";
      "--max-time";
      "620";
      "-w";
      "\n%{http_code}";
      "--connect-timeout";
      "2";
      "-H";
      "x-piss-session-token: " ^ broker_token;
    ]
  in
  let arguments =
    match body with
    | None -> base @ [ url ]
    | Some json ->
        base
        @ [
            "-X";
            "POST";
            "-H";
            "content-type: application/json";
            "--data-binary";
            Yojson.Safe.to_string json;
            url;
          ]
  in
  let environment = Unix.environment () in
  let stdout, stdin, stderr =
    Unix.open_process_args_full curl_command (Array.of_list arguments)
      environment
  in
  let output = read_channel stdout in
  let errors = read_channel stderr in
  match Unix.close_process_full (stdout, stdin, stderr) with
  | Unix.WEXITED 0 -> (
      let body, status = split_http_response output in
      match status with
      | Some code when code >= 200 && code < 300 -> Yojson.Safe.from_string body
      | Some code ->
          failwith
            (Printf.sprintf "session broker returned HTTP %d: %s" code body)
      | None ->
          raise (Broker_unavailable "broker returned an invalid HTTP status"))
  | Unix.WEXITED code ->
      raise
        (Broker_unavailable
           (Printf.sprintf "session broker request failed (%d): %s" code errors))
  | Unix.WSIGNALED signal | Unix.WSTOPPED signal ->
      raise
        (Broker_unavailable
           (Printf.sprintf "session broker request received signal %d" signal))

let retry_broker request =
  let deadline = Unix.gettimeofday () +. 620. in
  let rec attempt () =
    try request ()
    with Broker_unavailable _ as exn ->
      if Unix.gettimeofday () >= deadline then raise exn
      else (
        Unix.sleepf 1.;
        attempt ())
  in
  attempt ()

let random_request_id () =
  let channel = open_in_bin "/proc/sys/kernel/random/uuid" in
  Fun.protect
    ~finally:(fun () -> close_in_noerr channel)
    (fun () -> "mcp-" ^ String.trim (input_line channel))

let tool_result ?(is_error = false) text =
  `Assoc
    [
      ( "content",
        `List [ `Assoc [ ("type", `String "text"); ("text", `String text) ] ] );
      ("isError", `Bool is_error);
    ]

let peer_input_schema =
  `Assoc
    [
      ("type", `String "object");
      ( "properties",
        `Assoc
          [
            ( "targetSessionId",
              `Assoc
                [
                  ("type", `String "string");
                  ("description", `String "Target PISS session ID");
                ] );
            ( "prompt",
              `Assoc
                [
                  ("type", `String "string");
                  ("description", `String "Work request for the target agent");
                ] );
          ] );
      ("required", `List [ `String "targetSessionId"; `String "prompt" ]);
      ("additionalProperties", `Bool false);
    ]

let tools =
  `List
    [
      `Assoc
        [
          ("name", `String "piss_list_sessions");
          ( "description",
            `String
              "List active PISS sessions available for agent-to-agent \
               collaboration." );
          ( "inputSchema",
            `Assoc
              [
                ("type", `String "object");
                ("properties", `Assoc []);
                ("additionalProperties", `Bool false);
              ] );
        ];
      `Assoc
        [
          ("name", `String "piss_ask_session");
          ( "description",
            `String
              "Ask another active PISS session to perform one durable turn and \
               return its response. Use piss_list_sessions first to choose the \
               target." );
          ("inputSchema", peer_input_schema);
        ];
      `Assoc
        [
          ("name", `String "piss_send_session");
          ( "description",
            `String
              "Send work to another PISS session without waiting. Returns a \
               durable request ID for later collection, enabling parallel \
               fan-out." );
          ("inputSchema", peer_input_schema);
        ];
      `Assoc
        [
          ("name", `String "piss_subscribe_responses");
          ( "description",
            `String
              "Durably subscribe this orchestrator to asynchronous request \
               completion, then end the current turn. PISS will wait while the \
               session is dormant and automatically start exactly one new turn \
               with the captured responses when any or all requests are \
               finished." );
          ( "inputSchema",
            `Assoc
              [
                ("type", `String "object");
                ( "properties",
                  `Assoc
                    [
                      ( "requestIds",
                        `Assoc
                          [
                            ("type", `String "array");
                            ("items", `Assoc [ ("type", `String "string") ]);
                            ("minItems", `Int 1);
                            ("maxItems", `Int 64);
                          ] );
                      ( "waitFor",
                        `Assoc
                          [
                            ("type", `String "string");
                            ("enum", `List [ `String "any"; `String "all" ]);
                            ("default", `String "all");
                          ] );
                    ] );
                ("required", `List [ `String "requestIds" ]);
                ("additionalProperties", `Bool false);
              ] );
        ];
      `Assoc
        [
          ("name", `String "piss_collect_responses");
          ( "description",
            `String
              "Listen for completion of asynchronous session requests. Wait \
               for any response or all responses, and return captured outputs \
               plus pending request IDs. To keep listening after waitFor=any, \
               call again with the returned pendingRequestIds." );
          ( "inputSchema",
            `Assoc
              [
                ("type", `String "object");
                ( "properties",
                  `Assoc
                    [
                      ( "requestIds",
                        `Assoc
                          [
                            ("type", `String "array");
                            ("items", `Assoc [ ("type", `String "string") ]);
                            ("minItems", `Int 1);
                            ("maxItems", `Int 64);
                          ] );
                      ( "waitFor",
                        `Assoc
                          [
                            ("type", `String "string");
                            ("enum", `List [ `String "any"; `String "all" ]);
                            ("default", `String "all");
                          ] );
                      ( "timeoutSeconds",
                        `Assoc
                          [
                            ("type", `String "number");
                            ("minimum", `Int 0);
                            ("maximum", `Int 600);
                            ("default", `Int 600);
                          ] );
                    ] );
                ("required", `List [ `String "requestIds" ]);
                ("additionalProperties", `Bool false);
              ] );
        ];
    ]

let member name json = Yojson.Safe.Util.member name json

let peer_request_body arguments =
  let target =
    match member "targetSessionId" arguments with
    | `String value -> value
    | _ -> failwith "targetSessionId must be a string"
  in
  let prompt =
    match member "prompt" arguments with
    | `String value -> value
    | _ -> failwith "prompt must be a string"
  in
  `Assoc
    [
      ("requestId", `String (random_request_id ()));
      ("targetSessionId", `String target);
      ("prompt", `String prompt);
    ]

let call_tool params =
  let name = member "name" params in
  let arguments = member "arguments" params in
  match name with
  | `String "piss_list_sessions" ->
      curl "/api/v2/broker/sessions"
      |> Yojson.Safe.pretty_to_string |> tool_result
  | `String "piss_ask_session" -> (
      let body = peer_request_body arguments in
      let response = retry_broker (fun () -> curl ~body "/api/v2/broker/ask") in
      match member "response" response with
      | `String value -> tool_result value
      | _ -> failwith "session broker returned no response")
  | `String "piss_send_session" ->
      let body = peer_request_body arguments in
      retry_broker (fun () -> curl ~body "/api/v2/broker/send")
      |> Yojson.Safe.pretty_to_string |> tool_result
  | `String "piss_subscribe_responses" ->
      let body =
        match arguments with
        | `Assoc fields ->
            `Assoc (("subscriptionId", `String (random_request_id ())) :: fields)
        | _ -> failwith "subscription arguments must be an object"
      in
      retry_broker (fun () -> curl ~body "/api/v2/broker/subscribe")
      |> Yojson.Safe.pretty_to_string |> tool_result
  | `String "piss_collect_responses" ->
      retry_broker (fun () -> curl ~body:arguments "/api/v2/broker/collect")
      |> Yojson.Safe.pretty_to_string |> tool_result
  | `String value -> failwith ("unknown tool: " ^ value)
  | _ -> failwith "tool name must be a string"

let response id result =
  `Assoc [ ("jsonrpc", `String "2.0"); ("id", id); ("result", result) ]

let error_response id message =
  `Assoc
    [
      ("jsonrpc", `String "2.0");
      ("id", id);
      ("error", `Assoc [ ("code", `Int (-32603)); ("message", `String message) ]);
    ]

let handle json =
  let id = member "id" json in
  match member "method" json with
  | `String "initialize" ->
      Some
        (response id
           (`Assoc
              [
                ("protocolVersion", `String "2024-11-05");
                ("capabilities", `Assoc [ ("tools", `Assoc []) ]);
                ( "serverInfo",
                  `Assoc
                    [
                      ("name", `String "piss-sessions");
                      ("version", `String "0.1.0");
                    ] );
              ]))
  | `String "tools/list" -> Some (response id (`Assoc [ ("tools", tools) ]))
  | `String "tools/call" -> (
      try Some (response id (call_tool (member "params" json)))
      with exn ->
        Some (response id (tool_result ~is_error:true (Printexc.to_string exn)))
      )
  | `String "ping" -> Some (response id (`Assoc []))
  | `String method_ when id <> `Null ->
      Some (error_response id ("unsupported MCP method: " ^ method_))
  | _ -> None

let () =
  try
    while true do
      let line = input_line stdin in
      if String.trim line <> "" then
        let json = Yojson.Safe.from_string line in
        match handle json with
        | Some reply ->
            print_endline (Yojson.Safe.to_string reply);
            flush stdout
        | None -> ()
    done
  with End_of_file -> ()
