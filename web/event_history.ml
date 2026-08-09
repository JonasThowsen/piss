open! Core

type command_state =
  | Received
  | Accepted
  | Dispatched
  | Acknowledged
  | Completed
  | Cancelled
  | Ambiguous
  | Rejected

type entry =
  | User of { sequence : int64; command_id : string; text : string }
  | Agent of { sequence : int64; message_id : string; text : string }
  | Tool of {
      sequence : int64;
      tool_call_id : string;
      title : string;
      detail : string;
      status : string;
    }
  | Command_state of {
      sequence : int64;
      command_id : string;
      state : command_state;
    }

let ( let* ) result f = Result.bind result ~f
let error path message = Error (path ^ " " ^ message)

let assoc path = function
  | `Assoc fields -> Ok fields
  | _ -> error path "must be an object"

let field fields path name =
  match List.Assoc.find fields ~equal:String.equal name with
  | Some value -> Ok value
  | None -> error (path ^ "." ^ name) "is required"

let string path = function
  | `String value -> Ok value
  | _ -> error path "must be a string"

let nonempty_string path json =
  let* value = string path json in
  if String.is_empty value then error path "must not be empty" else Ok value

let int path = function
  | `Int value -> Ok value
  | `Intlit value -> (
      match Int.of_string_opt value with
      | Some value -> Ok value
      | None -> error path "must be an integer")
  | _ -> error path "must be an integer"

let int64 path = function
  | `Int value -> Ok (Int64.of_int value)
  | `Intlit value -> (
      match Int64.of_string_opt value with
      | Some value -> Ok value
      | None -> error path "must be an integer")
  | _ -> error path "must be an integer"

let number path = function
  | `Int value -> Ok (Float.of_int value)
  | `Intlit value -> (
      match Float.of_string_opt value with
      | Some value when Float.is_finite value -> Ok value
      | _ -> error path "must be a finite number")
  | `Float value when Float.is_finite value -> Ok value
  | _ -> error path "must be a finite number"

let list path = function
  | `List values -> Ok values
  | _ -> error path "must be an array"

let optional_field fields path name decode =
  match List.Assoc.find fields ~equal:String.equal name with
  | None -> Ok None
  | Some value -> Result.map (decode (path ^ "." ^ name) value) ~f:Option.some

let command_state_to_string = function
  | Received -> "received"
  | Accepted -> "accepted"
  | Dispatched -> "dispatched"
  | Acknowledged -> "acknowledged"
  | Completed -> "completed"
  | Cancelled -> "cancelled"
  | Ambiguous -> "ambiguous"
  | Rejected -> "rejected"

let command_state path json =
  let* value = string path json in
  match value with
  | "received" -> Ok Received
  | "accepted" -> Ok Accepted
  | "dispatched" -> Ok Dispatched
  | "acknowledged" -> Ok Acknowledged
  | "completed" -> Ok Completed
  | "cancelled" -> Ok Cancelled
  | "ambiguous" -> Ok Ambiguous
  | "rejected" -> Ok Rejected
  | _ -> error path ("has unsupported value " ^ value)

let tool_status path json =
  let* value = string path json in
  match value with
  | "pending" | "in_progress" | "completed" | "failed" -> Ok value
  | _ -> error path ("has unsupported value " ^ value)

let field_as fields path name decode =
  let* value = field fields path name in
  decode (path ^ "." ^ name) value

let rec content_text path json =
  let* fields = assoc path json in
  let* type_ = field_as fields path "type" string in
  match type_ with
  | "text" ->
      let* text = field_as fields path "text" string in
      Ok (Some text)
  | "content" ->
      let* content = field fields path "content" in
      content_text (path ^ ".content") content
  | _ -> Ok None

let content_list_text path json =
  let* contents = list path json in
  let* texts =
    contents
    |> List.mapi ~f:(fun index content ->
        content_text (Printf.sprintf "%s[%d]" path index) content)
    |> Result.all
  in
  Ok (texts |> List.filter_opt |> String.concat ~sep:"\n")

let acp_update path expected_kind payload =
  let* payload_fields = assoc path payload in
  let* jsonrpc = field_as payload_fields path "jsonrpc" string in
  if not (String.equal jsonrpc "2.0") then
    error (path ^ ".jsonrpc") "must be 2.0"
  else
    let* method_ = field_as payload_fields path "method" string in
    if not (String.equal method_ "session/update") then
      error (path ^ ".method") "must be session/update"
    else
      let* params = field_as payload_fields path "params" assoc in
      let params_path = path ^ ".params" in
      let* _session_id =
        field_as params params_path "sessionId" nonempty_string
      in
      let* update = field_as params params_path "update" assoc in
      let update_path = params_path ^ ".update" in
      let* kind = field_as update update_path "sessionUpdate" string in
      if String.equal kind expected_kind then Ok (update, update_path)
      else error (update_path ^ ".sessionUpdate") ("must be " ^ expected_kind)

let describe_input path fields =
  let* raw_input = optional_field fields path "rawInput" assoc in
  match raw_input with
  | None -> Ok ""
  | Some input ->
      let first_string names =
        List.find_map names ~f:(fun name ->
            match List.Assoc.find input ~equal:String.equal name with
            | Some (`String value) -> Some value
            | _ -> None)
      in
      Ok
        (match first_string [ "command"; "path"; "query"; "pattern" ] with
        | Some value -> value
        | None -> Yojson.Safe.to_string (`Assoc input))

let decode_command_accepted path sequence payload =
  let* fields = assoc path payload in
  let* command_id = field_as fields path "commandId" nonempty_string in
  let* _request_id = field_as fields path "requestId" nonempty_string in
  let* action = field_as fields path "action" string in
  let* text = field_as fields path "text" string in
  let* image_count = field_as fields path "imageCount" int in
  let* images = field_as fields path "images" list in
  let* resource_count = field_as fields path "resourceCount" int in
  let* resources = field_as fields path "resources" list in
  if
    not (List.mem [ "prompt"; "steer"; "follow_up" ] action ~equal:String.equal)
  then error (path ^ ".action") "has an unsupported value"
  else if image_count < 0 || image_count <> List.length images then
    error (path ^ ".imageCount") "must match images"
  else if resource_count < 0 || resource_count <> List.length resources then
    error (path ^ ".resourceCount") "must match resources"
  else if String.is_empty text && image_count = 0 && resource_count = 0 then
    error path "must contain prompt content"
  else Ok (Some (User { sequence; command_id; text }))

let decode_command_state path sequence payload =
  let* fields = assoc path payload in
  let* command_id = field_as fields path "commandId" nonempty_string in
  let* state = field_as fields path "state" command_state in
  Ok (Some (Command_state { sequence; command_id; state }))

let decode_message path sequence payload expected_kind role =
  let* update, update_path = acp_update path expected_kind payload in
  let* message_id = field_as update update_path "messageId" nonempty_string in
  let* content = field update update_path "content" in
  let* text = content_text (update_path ^ ".content") content in
  match (role, text) with
  | `Agent, Some text -> Ok (Some (Agent { sequence; message_id; text }))
  | `User, Some _ ->
      (* command.accepted is the durable user entry; the ACP echo would render
         the same prompt twice. *)
      Ok None
  | _, None -> Ok None

let decode_tool_call path sequence payload =
  let* update, update_path = acp_update path "tool_call" payload in
  let* tool_call_id =
    field_as update update_path "toolCallId" nonempty_string
  in
  let* title = field_as update update_path "title" nonempty_string in
  let* _kind = field_as update update_path "kind" nonempty_string in
  let* status = field_as update update_path "status" tool_status in
  let* detail = describe_input update_path update in
  Ok (Some (Tool { sequence; tool_call_id; title; detail; status }))

let decode_tool_update path sequence payload =
  let* update, update_path = acp_update path "tool_call_update" payload in
  let* tool_call_id =
    field_as update update_path "toolCallId" nonempty_string
  in
  let* title = optional_field update update_path "title" nonempty_string in
  let* status = optional_field update update_path "status" tool_status in
  let* input = describe_input update_path update in
  let* output =
    match List.Assoc.find update ~equal:String.equal "content" with
    | None -> Ok ""
    | Some content -> content_list_text (update_path ^ ".content") content
  in
  let detail =
    List.filter [ input; output ] ~f:(Fn.non String.is_empty)
    |> String.concat ~sep:"\n"
  in
  Ok
    (Some
       (Tool
          {
            sequence;
            tool_call_id;
            title = Option.value title ~default:"Tool update";
            detail;
            status = Option.value status ~default:"in_progress";
          }))

let decode_event index json =
  let path = Printf.sprintf "events[%d]" index in
  let* fields = assoc path json in
  let* sequence = field_as fields path "sequence" int64 in
  let* kind = field_as fields path "kind" nonempty_string in
  let* payload = field fields path "payload" in
  let* _created_at = field_as fields path "createdAt" number in
  let payload_path = path ^ ".payload" in
  let* entry =
    match kind with
    | "command.accepted" ->
        decode_command_accepted payload_path sequence payload
    | "command.state" | "command.reconciled" ->
        decode_command_state payload_path sequence payload
    | "acp.user_message_chunk" ->
        decode_message payload_path sequence payload "user_message_chunk" `User
    | "acp.agent_message_chunk" ->
        decode_message payload_path sequence payload "agent_message_chunk"
          `Agent
    | "acp.tool_call" -> decode_tool_call payload_path sequence payload
    | "acp.tool_call_update" -> decode_tool_update payload_path sequence payload
    | _ -> Ok None
  in
  Ok (sequence, entry)

let decode body =
  match Result.try_with (fun () -> Yojson.Safe.from_string body) with
  | Error exn -> Error ("response is not valid JSON: " ^ Exn.to_string exn)
  | Ok (`List events) ->
      let* decoded = events |> List.mapi ~f:decode_event |> Result.all in
      let rec validate_order previous entries = function
        | [] -> Ok (List.rev entries)
        | (sequence, entry) :: rest ->
            if Int64.(sequence <= previous) then
              Error "event sequences must be strictly increasing"
            else
              validate_order sequence
                (Option.value_map entry ~default:entries ~f:(fun value ->
                     value :: entries))
                rest
      in
      validate_order Int64.min_value [] decoded
  | Ok _ -> Error "response must be a JSON array"

let command_is_terminal ~command_id entries =
  List.exists entries ~f:(function
    | Command_state { command_id = candidate; state; _ }
      when String.equal command_id candidate -> (
        match state with
        | Completed | Cancelled | Ambiguous | Rejected -> true
        | Received | Accepted | Dispatched | Acknowledged -> false)
    | _ -> false)
