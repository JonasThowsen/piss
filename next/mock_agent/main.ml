open Piss_core

let write json =
  Yojson.Safe.to_channel stdout json;
  output_char stdout '\n';
  flush stdout

let response_id json =
  match Yojson.Safe.Util.member "id" json with
  | `String id -> id
  | `Int id -> string_of_int id
  | value -> Yojson.Safe.to_string value

let session_update ~session_id update =
  Acp.notification ~method_:"session/update"
    (`Assoc [ ("sessionId", `String session_id); ("update", update) ])

let duration () =
  match Sys.getenv_opt "PISS_MOCK_DURATION" with
  | Some value -> ( try max 1 (int_of_string value) with Failure _ -> 8)
  | None -> 8

let request_permission ~id ~session_id =
  let request_id = "permission-" ^ id in
  write
    (Acp.request ~id:request_id ~method_:"session/request_permission"
       (`Assoc
          [
            ("sessionId", `String session_id);
            ( "toolCall",
              `Assoc
                [
                  ("toolCallId", `String ("tool-" ^ id));
                  ("title", `String "Allow the stability proof");
                  ("kind", `String "execute");
                  ("status", `String "pending");
                  ("rawInput", `Assoc [ ("command", `String "mock-proof") ]);
                ] );
            ( "options",
              `List
                [
                  `Assoc
                    [
                      ("optionId", `String "allow-once");
                      ("name", `String "Allow once");
                      ("kind", `String "allow_once");
                    ];
                  `Assoc
                    [
                      ("optionId", `String "reject-once");
                      ("name", `String "Reject");
                      ("kind", `String "reject_once");
                    ];
                ] );
          ]));
  let response = input_line stdin |> Yojson.Safe.from_string in
  match
    Yojson.Safe.Util.(
      response |> member "result" |> member "outcome" |> member "optionId")
  with
  | `String "allow-once" -> true
  | _ -> false

let prompt_contents params =
  match Yojson.Safe.Util.member "prompt" params with
  | `List contents -> contents
  | _ -> []

let prompt_text params =
  prompt_contents params
  |> List.find_map (fun content ->
      match
        ( Yojson.Safe.Util.member "type" content,
          Yojson.Safe.Util.member "text" content )
      with
      | `String "text", `String value -> Some value
      | _ -> None)
  |> Option.value ~default:""

let prompt_images params =
  prompt_contents params
  |> List.filter (fun content ->
      Yojson.Safe.Util.member "type" content = `String "image")

let write_user_prompt ~id ~session_id ~text ~images =
  if text <> "" then
    write
      (session_update ~session_id
         (`Assoc
            [
              ("sessionUpdate", `String "user_message_chunk");
              ("messageId", `String ("user-" ^ id));
              ( "content",
                `Assoc [ ("type", `String "text"); ("text", `String text) ] );
            ]));
  List.iter
    (fun content ->
      write
        (session_update ~session_id
           (`Assoc
              [
                ("sessionUpdate", `String "user_message_chunk");
                ("messageId", `String ("user-" ^ id));
                ("content", content);
              ])))
    images

let pending_prompts : (string * string * Yojson.Safe.t list) Queue.t =
  Queue.create ()

let poll_pending ~session_id () =
  let readable, _, _ = Unix.select [ Unix.stdin ] [] [] 0. in
  match readable with
  | [] -> false
  | _ ->
      let json = input_line stdin |> Yojson.Safe.from_string in
      if Yojson.Safe.Util.member "method" json = `String "session/cancel" then
        true
      else if Yojson.Safe.Util.member "method" json = `String "session/prompt"
      then (
        let id = response_id json in
        let params = Yojson.Safe.Util.member "params" json in
        let text = prompt_text params in
        let images = prompt_images params in
        let delivery =
          Yojson.Safe.Util.(
            params |> member "_meta" |> member "piss" |> member "delivery")
        in
        match delivery with
        | `String "steer" ->
            write_user_prompt ~id ~session_id ~text ~images;
            write
              (Acp.response ~id (`Assoc [ ("stopReason", `String "end_turn") ]));
            false
        | `String "follow_up" ->
            Queue.add (id, text, images) pending_prompts;
            false
        | _ ->
            Queue.add (id, text, images) pending_prompts;
            false)
      else false

let rec run_prompt ~id ~session_id ~text ~images =
  write_user_prompt ~id ~session_id ~text ~images;
  let allowed =
    if String.starts_with ~prefix:"permission:" text then
      request_permission ~id ~session_id
    else true
  in
  if not allowed then
    write (Acp.response ~id (`Assoc [ ("stopReason", `String "cancelled") ]))
  else (
    write
      (session_update ~session_id
         (`Assoc
            [
              ("sessionUpdate", `String "tool_call");
              ("toolCallId", `String ("tool-" ^ id));
              ("title", `String "Running durability tests");
              ("kind", `String "execute");
              ("status", `String "in_progress");
              ( "rawInput",
                `Assoc
                  [
                    ("command", `String "dune runtest");
                    ("durationSeconds", `Int (duration ()));
                  ] );
            ]));
    let cancelled = ref false in
    let second = ref 1 in
    while !second <= duration () && not !cancelled do
      Unix.sleepf 1.;
      if poll_pending ~session_id () then cancelled := true
      else
        write
          (session_update ~session_id
             (`Assoc
                [
                  ("sessionUpdate", `String "tool_call_update");
                  ("toolCallId", `String ("tool-" ^ id));
                  ("status", `String "in_progress");
                  ( "content",
                    `List
                      [
                        `Assoc
                          [
                            ("type", `String "content");
                            ( "content",
                              `Assoc
                                [
                                  ("type", `String "text");
                                  ( "text",
                                    `String
                                      (Printf.sprintf "durable output %d/%d"
                                         !second (duration ())) );
                                ] );
                          ];
                      ] );
                ]));
      incr second
    done;
    if !cancelled then (
      Queue.clear pending_prompts;
      write (Acp.response ~id (`Assoc [ ("stopReason", `String "cancelled") ])))
    else (
      write
        (session_update ~session_id
           (`Assoc
              [
                ("sessionUpdate", `String "tool_call_update");
                ("toolCallId", `String ("tool-" ^ id));
                ("status", `String "completed");
                ( "locations",
                  `List
                    [
                      `Assoc
                        [
                          ("path", `String "/workspace/mock-proof.txt");
                          ("line", `Int 1);
                        ];
                    ] );
                ( "content",
                  `List
                    [
                      `Assoc
                        [
                          ("type", `String "content");
                          ( "content",
                            `Assoc
                              [
                                ("type", `String "text");
                                ( "text",
                                  `String
                                    "2 tests passed\nagent process stayed alive"
                                );
                              ] );
                        ];
                      `Assoc
                        [
                          ("type", `String "diff");
                          ("path", `String "/workspace/mock-proof.txt");
                          ("oldText", `String "before\n");
                          ("newText", `String "after\n");
                        ];
                      `Assoc
                        [
                          ("type", `String "terminal");
                          ("terminalId", `String "mock-terminal");
                        ];
                      `Assoc
                        [
                          ("type", `String "content");
                          ( "content",
                            `Assoc
                              [
                                ("type", `String "image");
                                ("mimeType", `String "image/png");
                                ( "data",
                                  `String
                                    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
                                );
                              ] );
                        ];
                      `Assoc
                        [
                          ("type", `String "content");
                          ( "content",
                            `Assoc
                              [
                                ("type", `String "resource");
                                ( "resource",
                                  `Assoc
                                    [
                                      ( "uri",
                                        `String
                                          "file:///workspace/durability-report.md"
                                      );
                                      ("name", `String "Durability report");
                                    ] );
                              ] );
                        ];
                    ] );
              ]));
      write
        (session_update ~session_id
           (`Assoc
              [
                ("sessionUpdate", `String "agent_message_chunk");
                ("messageId", `String ("agent-" ^ id));
                ( "content",
                  `Assoc
                    [
                      ("type", `String "text");
                      ( "text",
                        `String
                          (if images <> [] then
                             Printf.sprintf "Received %d image attachment%s."
                               (List.length images)
                               (if List.length images = 1 then "" else "s")
                           else if String.starts_with ~prefix:"markdown:" text
                           then
                             "## Copy proof\n\n\
                              This **message** contains `inline code` and a \
                              link to [ACP](https://agentclientprotocol.com).\n\n\
                              - first item\n\
                              - second item\n\n\
                              ```ocaml\n\
                              let durable = true\n\
                              ```\n\n\
                              > Copy this quoted block directly."
                           else
                             "The worker retained ownership while the control \
                              plane was replaceable.") );
                    ] );
              ]));
      write (Acp.response ~id (`Assoc [ ("stopReason", `String "end_turn") ]))));
  if not (Queue.is_empty pending_prompts) then
    let next_id, next_text, next_images = Queue.take pending_prompts in
    run_prompt ~id:next_id ~session_id ~text:next_text ~images:next_images

let config_options ~model ~thinking =
  `List
    [
      `Assoc
        [
          ("type", `String "select");
          ("id", `String "model");
          ("category", `String "model");
          ("name", `String "Model");
          ("currentValue", `String model);
          ( "options",
            `List
              [
                `Assoc
                  [
                    ("value", `String "mock/fast"); ("name", `String "Mock Fast");
                  ];
                `Assoc
                  [
                    ("value", `String "mock/deep"); ("name", `String "Mock Deep");
                  ];
              ] );
        ];
      `Assoc
        [
          ("type", `String "select");
          ("id", `String "thought_level");
          ("category", `String "thought_level");
          ("name", `String "Thinking");
          ("currentValue", `String thinking);
          ( "options",
            `List
              (List.map
                 (fun value ->
                   `Assoc [ ("value", `String value); ("name", `String value) ])
                 [ "off"; "low"; "medium"; "high" ]) );
        ];
    ]

let () =
  let session_id = "mock-acp-session" in
  let model = ref "mock/fast" in
  let thinking = ref "medium" in
  try
    while true do
      let json = input_line stdin |> Yojson.Safe.from_string in
      let method_ =
        match Yojson.Safe.Util.member "method" json with
        | `String value -> value
        | _ -> ""
      in
      let id = response_id json in
      match method_ with
      | "initialize" ->
          write
            (Acp.response ~id
               (`Assoc
                  [
                    ("protocolVersion", `Int 1);
                    ( "agentCapabilities",
                      `Assoc
                        [
                          ("loadSession", `Bool false);
                          ( "promptCapabilities",
                            `Assoc [ ("image", `Bool true) ] );
                        ] );
                    ( "agentInfo",
                      `Assoc
                        [
                          ("name", `String "piss-mock-agent");
                          ("title", `String "PISS replaceability tracer");
                          ("version", `String "0.1.0");
                        ] );
                    ("authMethods", `List []);
                  ]))
      | "session/new" ->
          write
            (Acp.response ~id
               (`Assoc
                  [
                    ("sessionId", `String session_id);
                    ( "configOptions",
                      config_options ~model:!model ~thinking:!thinking );
                  ]))
      | "session/set_config_option" ->
          let params = Yojson.Safe.Util.member "params" json in
          let config_id = Yojson.Safe.Util.member "configId" params in
          let value = Yojson.Safe.Util.member "value" params in
          (match (config_id, value) with
          | `String "model", `String selected -> model := selected
          | `String "thought_level", `String selected -> thinking := selected
          | _ -> ());
          write
            (Acp.response ~id
               (`Assoc
                  [
                    ( "configOptions",
                      config_options ~model:!model ~thinking:!thinking );
                  ]))
      | "session/prompt" ->
          let params = Yojson.Safe.Util.member "params" json in
          let text = prompt_text params in
          let images = prompt_images params in
          run_prompt ~id ~session_id ~text ~images
      | "session/cancel" -> ()
      | _ ->
          write
            (`Assoc
               [
                 ("jsonrpc", `String "2.0");
                 ("id", `String id);
                 ( "error",
                   `Assoc
                     [
                       ("code", `Int (-32601));
                       ("message", `String "method not found");
                     ] );
               ])
    done
  with End_of_file -> ()
