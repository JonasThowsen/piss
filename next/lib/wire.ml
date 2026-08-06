type request =
  | Hello of { protocol_version : int }
  | Snapshot
  | Events of { after : int64; limit : int }
  | Recent_events of { limit : int }
  | New_session
  | Prompt of { command_id : string; text : string }
  | Cancel
  | Permission of { request_id : string; option_id : string option }
  | Peer_event of {
      kind : string;
      request_id : string;
      peer_id : string;
      text : string;
    }

type response = (Yojson.Safe.t, string) result

let member name json = Yojson.Safe.Util.member name json

let string_member name json =
  match member name json with
  | `String value -> Ok value
  | _ -> Error (Printf.sprintf "%s must be a string" name)

let int_member ?default name json =
  match member name json with
  | `Int value -> Ok value
  | `Intlit value -> (
      try Ok (int_of_string value)
      with Failure _ -> Error (Printf.sprintf "%s must be an integer" name))
  | `Null -> (
      match default with
      | Some value -> Ok value
      | None -> Error (Printf.sprintf "%s is required" name))
  | _ -> Error (Printf.sprintf "%s must be an integer" name)

let int64_member ?default name json =
  match member name json with
  | `Int value -> Ok (Int64.of_int value)
  | `Intlit value -> (
      try Ok (Int64.of_string value)
      with Failure _ -> Error (Printf.sprintf "%s must be an integer" name))
  | `Null -> (
      match default with
      | Some value -> Ok value
      | None -> Error (Printf.sprintf "%s is required" name))
  | _ -> Error (Printf.sprintf "%s must be an integer" name)

let ( let* ) = Result.bind

let request_of_yojson json =
  let* operation = string_member "op" json in
  match operation with
  | "hello" ->
      let* protocol_version = int_member "protocolVersion" json in
      Ok (Hello { protocol_version })
  | "snapshot" -> Ok Snapshot
  | "events" ->
      let* after = int64_member ~default:0L "after" json in
      let* limit = int_member ~default:200 "limit" json in
      if limit < 1 || limit > 500 then Error "limit must be between 1 and 500"
      else Ok (Events { after; limit })
  | "recent_events" ->
      let* limit = int_member ~default:500 "limit" json in
      if limit < 1 || limit > 500 then Error "limit must be between 1 and 500"
      else Ok (Recent_events { limit })
  | "new_session" -> Ok New_session
  | "prompt" ->
      let* command_id = string_member "commandId" json in
      let* text = string_member "text" json in
      if command_id = "" then Error "commandId must not be empty"
      else if String.length command_id > 128 then Error "commandId is too long"
      else if text = "" then Error "prompt must not be empty"
      else if String.length text > 64 * 1024 then Error "prompt is too large"
      else Ok (Prompt { command_id; text })
  | "cancel" -> Ok Cancel
  | "peer_event" ->
      let* kind = string_member "kind" json in
      let* request_id = string_member "requestId" json in
      let* peer_id = string_member "peerId" json in
      let* text = string_member "text" json in
      if
        not
          (List.exists (String.equal kind)
             [
               "session.ask.sent";
               "session.ask.received";
               "session.ask.completed";
             ])
      then Error "unsupported peer event kind"
      else if request_id = "" || String.length request_id > 128 then
        Error "requestId must contain between 1 and 128 characters"
      else if peer_id = "" || String.length peer_id > 64 then
        Error "peerId must contain between 1 and 64 characters"
      else if String.length text > 64 * 1024 then
        Error "peer event text is too long"
      else Ok (Peer_event { kind; request_id; peer_id; text })
  | "permission" ->
      let* request_id = string_member "requestId" json in
      let option_id =
        match member "optionId" json with
        | `String value -> Ok (Some value)
        | `Null -> Ok None
        | _ -> Error "optionId must be a string or null"
      in
      let* option_id = option_id in
      if request_id = "" || String.length request_id > 128 then
        Error "requestId must contain between 1 and 128 characters"
      else if
        Option.fold ~none:false
          ~some:(fun value -> String.length value > 128)
          option_id
      then Error "optionId is too long"
      else Ok (Permission { request_id; option_id })
  | value -> Error ("unknown operation: " ^ value)

let response_to_yojson = function
  | Ok result -> `Assoc [ ("ok", `Bool true); ("result", result) ]
  | Error message -> `Assoc [ ("ok", `Bool false); ("error", `String message) ]

let response_of_yojson json =
  match member "ok" json with
  | `Bool true -> Ok (member "result" json)
  | `Bool false -> (
      match string_member "error" json with
      | Ok message -> Error message
      | Error message -> Error message)
  | _ -> Error "worker response is missing ok"
