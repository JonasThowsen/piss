type request_id = string

type envelope =
  | Response of {
      id : request_id;
      result : Yojson.Safe.t option;
      error : Yojson.Safe.t option;
    }
  | Notification of { method_ : string; params : Yojson.Safe.t }
  | Request of { id : request_id; method_ : string; params : Yojson.Safe.t }

let id_to_string = function
  | `String value -> Some value
  | `Int value -> Some (string_of_int value)
  | `Intlit value -> Some value
  | _ -> None

let envelope_of_yojson json =
  let open Yojson.Safe.Util in
  let method_json = member "method" json in
  let id_json = member "id" json in
  match (method_json, id_to_string id_json) with
  | `String method_, Some id ->
      Ok (Request { id; method_; params = member "params" json })
  | `String method_, None ->
      Ok (Notification { method_; params = member "params" json })
  | _, Some id ->
      let result =
        match member "result" json with `Null -> None | value -> Some value
      in
      let error =
        match member "error" json with `Null -> None | value -> Some value
      in
      Ok (Response { id; result; error })
  | _ -> Error "invalid ACP JSON-RPC envelope"

let response_result ~expected_id json =
  match envelope_of_yojson json with
  | Ok (Response { id; result; error = None }) when String.equal id expected_id
    ->
      Ok (Option.value result ~default:`Null)
  | Ok (Response { id; error = Some error; _ }) when String.equal id expected_id
    ->
      let message =
        match Yojson.Safe.Util.member "message" error with
        | `String value -> value
        | _ -> Yojson.Safe.to_string error
      in
      Error (Printf.sprintf "ACP request %s failed: %s" expected_id message)
  | Ok (Response { id; _ }) ->
      Error
        (Printf.sprintf "expected ACP response %s but received %s" expected_id
           id)
  | Ok _ -> Error ("expected ACP response for " ^ expected_id)
  | Error message -> Error message

let request ~id ~method_ params =
  `Assoc
    [
      ("jsonrpc", `String "2.0");
      ("id", `String id);
      ("method", `String method_);
      ("params", params);
    ]

let response_with_id ~id result =
  `Assoc [ ("jsonrpc", `String "2.0"); ("id", id); ("result", result) ]

let error_response_with_id ~id ~code ~message =
  `Assoc
    [
      ("jsonrpc", `String "2.0");
      ("id", id);
      ("error", `Assoc [ ("code", `Int code); ("message", `String message) ]);
    ]

let response ~id result = response_with_id ~id:(`String id) result

let notification ~method_ params =
  `Assoc
    [
      ("jsonrpc", `String "2.0"); ("method", `String method_); ("params", params);
    ]

let initialize_request =
  request ~id:"initialize" ~method_:"initialize"
    (`Assoc
       [
         ("protocolVersion", `Int 1);
         ("clientCapabilities", `Assoc []);
         ( "clientInfo",
           `Assoc
             [
               ("name", `String "piss");
               ("title", `String "PISS session worker");
               ("version", `String "0.1.0-tracer");
             ] );
       ])

let mcp_servers ~command ~session_id ~broker_url ~broker_token ~curl_command =
  if command = "" then `List []
  else
    `List
      [
        `Assoc
          [
            ("name", `String "piss-sessions");
            ("command", `String command);
            ("args", `List []);
            ( "env",
              `List
                (List.map
                   (fun (name, value) ->
                     `Assoc [ ("name", `String name); ("value", `String value) ])
                   [
                     ("PISS_SESSION_ID", session_id);
                     ("PISS_BROKER_URL", broker_url);
                     ("PISS_SESSION_TOKEN", broker_token);
                     ("PISS_CURL", curl_command);
                   ]) );
          ];
      ]

let new_session_request ~cwd ~session_id ~mcp_command ~broker_url ~broker_token
    ~curl_command =
  request ~id:"session-new" ~method_:"session/new"
    (`Assoc
       [
         ("cwd", `String cwd);
         ( "mcpServers",
           mcp_servers ~command:mcp_command ~session_id ~broker_url
             ~broker_token ~curl_command );
       ])

let load_session_request ~session_id ~cwd ~piss_session_id ~mcp_command
    ~broker_url ~broker_token ~curl_command =
  request ~id:"session-load" ~method_:"session/load"
    (`Assoc
       [
         ("sessionId", `String session_id);
         ("cwd", `String cwd);
         ( "mcpServers",
           mcp_servers ~command:mcp_command ~session_id:piss_session_id
             ~broker_url ~broker_token ~curl_command );
       ])

let set_config_option_request ~id ~session_id ~config_id ~value =
  request ~id ~method_:"session/set_config_option"
    (`Assoc
       [
         ("sessionId", `String session_id);
         ("configId", `String config_id);
         ("value", `String value);
       ])

let cancel_notification ~session_id =
  notification ~method_:"session/cancel"
    (`Assoc [ ("sessionId", `String session_id) ])

let image_content (image : Domain.image_input) =
  `Assoc
    [
      ("type", `String "image");
      ("mimeType", `String image.mime_type);
      ("data", `String image.data);
    ]

let resource_link_content (resource : Workspace_files.resource) =
  `Assoc
    ([
       ("type", `String "resource_link");
       ("uri", `String resource.uri);
       ("name", `String resource.name);
       ("size", `Int resource.size);
     ]
    @
    match resource.mime_type with
    | Some value -> [ ("mimeType", `String value) ]
    | None -> [])

let prompt_request ~delivery ~command_id ~session_id ~text ~images ~resources =
  let prompt =
    (if text = "" then []
     else [ `Assoc [ ("type", `String "text"); ("text", `String text) ] ])
    @ List.map resource_link_content resources
    @ List.map image_content images
  in
  let fields =
    [ ("sessionId", `String session_id); ("prompt", `List prompt) ]
  in
  let fields =
    match delivery with
    | None -> fields
    | Some action ->
        ("_meta", `Assoc [ ("piss", `Assoc [ ("delivery", `String action) ]) ])
        :: fields
  in
  request ~id:command_id ~method_:"session/prompt" (`Assoc fields)

let replace_assoc name value fields =
  (name, value) :: List.remove_assoc name fields

let redact_user_image_data json =
  match json with
  | `Assoc json_fields -> (
      match List.assoc_opt "params" json_fields with
      | Some (`Assoc params_fields) -> (
          match List.assoc_opt "update" params_fields with
          | Some (`Assoc update_fields)
            when List.assoc_opt "sessionUpdate" update_fields
                 = Some (`String "user_message_chunk") -> (
              match List.assoc_opt "content" update_fields with
              | Some (`Assoc content_fields)
                when List.assoc_opt "type" content_fields
                     = Some (`String "image") ->
                  let redacted_content =
                    `Assoc (replace_assoc "data" (`String "") content_fields)
                  in
                  let redacted_update =
                    `Assoc
                      (replace_assoc "content" redacted_content update_fields)
                  in
                  let redacted_params =
                    `Assoc
                      (replace_assoc "update" redacted_update params_fields)
                  in
                  `Assoc (replace_assoc "params" redacted_params json_fields)
              | _ -> json)
          | _ -> json)
      | _ -> json)
  | _ -> json
