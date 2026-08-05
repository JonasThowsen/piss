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

let request ~id ~method_ params =
  `Assoc
    [
      ("jsonrpc", `String "2.0");
      ("id", `String id);
      ("method", `String method_);
      ("params", params);
    ]

let response ~id result =
  `Assoc [ ("jsonrpc", `String "2.0"); ("id", `String id); ("result", result) ]

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

let prompt_request ~command_id ~session_id ~text =
  request ~id:command_id ~method_:"session/prompt"
    (`Assoc
       [
         ("sessionId", `String session_id);
         ( "prompt",
           `List [ `Assoc [ ("type", `String "text"); ("text", `String text) ] ]
         );
       ])
