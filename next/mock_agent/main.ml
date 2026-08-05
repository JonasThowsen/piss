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

let run_prompt ~id ~session_id ~text =
  write
    (session_update ~session_id
       (`Assoc
          [
            ("sessionUpdate", `String "user_message_chunk");
            ("messageId", `String ("user-" ^ id));
            ( "content",
              `Assoc [ ("type", `String "text"); ("text", `String text) ] );
          ]));
  write
    (session_update ~session_id
       (`Assoc
          [
            ("sessionUpdate", `String "tool_call");
            ("toolCallId", `String ("tool-" ^ id));
            ("title", `String "Proving control-plane replaceability");
            ("kind", `String "execute");
            ("status", `String "in_progress");
            ("rawInput", `Assoc [ ("durationSeconds", `Int (duration ())) ]);
          ]));
  for second = 1 to duration () do
    Unix.sleepf 1.;
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
                                  (Printf.sprintf "durable output %d/%d" second
                                     (duration ())) );
                            ] );
                      ];
                  ] );
            ]))
  done;
  write
    (session_update ~session_id
       (`Assoc
          [
            ("sessionUpdate", `String "tool_call_update");
            ("toolCallId", `String ("tool-" ^ id));
            ("status", `String "completed");
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
                            ("text", `String "agent process stayed alive");
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
                      "The worker retained ownership while the control plane \
                       was replaceable." );
                ] );
          ]));
  write (Acp.response ~id (`Assoc [ ("stopReason", `String "end_turn") ]))

let () =
  let session_id = "mock-acp-session" in
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
                            `Assoc [ ("image", `Bool false) ] );
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
            (Acp.response ~id (`Assoc [ ("sessionId", `String session_id) ]))
      | "session/prompt" ->
          let params = Yojson.Safe.Util.member "params" json in
          let text =
            match Yojson.Safe.Util.(params |> member "prompt" |> to_list) with
            | first :: _ -> (
                match Yojson.Safe.Util.member "text" first with
                | `String value -> value
                | _ -> "")
            | [] -> ""
          in
          run_prompt ~id ~session_id ~text
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
