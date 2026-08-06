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

let new_session_request ~cwd =
  request ~id:"session-new" ~method_:"session/new"
    (`Assoc [ ("cwd", `String cwd); ("mcpServers", `List []) ])

let load_session_request ~session_id ~cwd =
  request ~id:"session-load" ~method_:"session/load"
    (`Assoc
       [
         ("sessionId", `String session_id);
         ("cwd", `String cwd);
         ("mcpServers", `List []);
       ])

let cancel_notification ~session_id =
  notification ~method_:"session/cancel"
    (`Assoc [ ("sessionId", `String session_id) ])

let prompt_request ~command_id ~session_id ~text =
  request ~id:command_id ~method_:"session/prompt"
    (`Assoc
       [
         ("sessionId", `String session_id);
         ( "prompt",
           `List [ `Assoc [ ("type", `String "text"); ("text", `String text) ] ]
         );
       ])
