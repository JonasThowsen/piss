type request =
  | Hello of { protocol_version : int }
  | Snapshot
  | Events of { after : int64; limit : int }
  | Prompt of { command_id : string; text : string }

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
  | "prompt" ->
      let* command_id = string_member "commandId" json in
      let* text = string_member "text" json in
      if String.length command_id > 128 then Error "commandId is too long"
      else if String.length text > 64 * 1024 then Error "prompt is too large"
      else Ok (Prompt { command_id; text })
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
