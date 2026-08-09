open! Core

type command_state = Timeline_projection.command_state =
  | Received
  | Accepted
  | Dispatched
  | Acknowledged
  | Completed
  | Cancelled
  | Ambiguous
  | Rejected

type permission_option = Timeline_projection.permission_option = {
  option_id : string;
  name : string;
  kind : string;
}

type permission_tool = Timeline_projection.permission_tool = {
  tool_call_id : string;
  title : string;
  kind : string;
  status : string;
  raw_input : Yojson.Safe.t option;
}

type permission_request = Timeline_projection.permission_request = {
  request_id : string;
  session_id : string;
  tool : permission_tool;
  options : permission_option list;
}

type entry = Timeline_projection.entry =
  | User of { sequence : int64; command_id : string; text : string }
  | Agent of { sequence : int64; message_id : string; text : string }
  | Tool of {
      sequence : int64;
      tool_call_id : string;
      title : string;
      input : string;
      output : string;
      status : string;
      artifacts : string list;
    }
  | Command_state of {
      sequence : int64;
      command_id : string;
      state : command_state;
    }
  | Permission_requested of { sequence : int64; request : permission_request }
  | Permission_resolved of {
      sequence : int64;
      request_id : string;
      option_id : string option;
    }
  | Permission_cancelled of { sequence : int64; request_id : string }

type pending_permission = { sequence : int64; request : permission_request }

type event = {
  sequence : int64;
  kind : string;
  update : Timeline_projection.update option;
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

let id_string path = function
  | `String value when not (String.is_empty value) -> Ok value
  | `Int value -> Ok (Int.to_string value)
  | `Intlit value -> (
      match Int64.of_string_opt value with
      | Some _ -> Ok value
      | None -> error path "must be a string or integer")
  | _ -> error path "must be a non-empty string or integer"

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
  else
    Ok (Some (Timeline_projection.User_update { sequence; command_id; text }))

let decode_command_state path sequence payload =
  let* fields = assoc path payload in
  let* command_id = field_as fields path "commandId" nonempty_string in
  let* state = field_as fields path "state" command_state in
  Ok
    (Some
       (Timeline_projection.Command_state_update { sequence; command_id; state }))

let decode_message path sequence payload expected_kind role =
  let* update, update_path = acp_update path expected_kind payload in
  let* message_id = field_as update update_path "messageId" nonempty_string in
  let* content = field update update_path "content" in
  let* text = content_text (update_path ^ ".content") content in
  match (role, text) with
  | `Agent, Some text ->
      Ok (Some (Timeline_projection.Agent_chunk { sequence; message_id; text }))
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
  Ok
    (Some
       (Timeline_projection.Tool_call
          {
            sequence;
            tool_call_id;
            title;
            input = detail;
            status;
            artifacts = [];
          }))

let decode_tool_update path sequence payload =
  let* update, update_path = acp_update path "tool_call_update" payload in
  let* tool_call_id =
    field_as update update_path "toolCallId" nonempty_string
  in
  let* title = optional_field update update_path "title" nonempty_string in
  let* status = optional_field update update_path "status" tool_status in
  let* input =
    match List.Assoc.find update ~equal:String.equal "rawInput" with
    | None -> Ok None
    | Some _ -> Result.map (describe_input update_path update) ~f:Option.some
  in
  let* output, content_artifacts =
    match List.Assoc.find update ~equal:String.equal "content" with
    | None -> Ok (None, [])
    | Some content ->
        Result.map
          (Acp_content.tool_content ~path:(update_path ^ ".content") content)
          ~f:(fun (output, artifacts) -> (Some output, artifacts))
  in
  let* location_artifacts = Acp_content.locations ~path:update_path update in
  Ok
    (Some
       (Timeline_projection.Tool_call_update
          {
            sequence;
            tool_call_id;
            title;
            input;
            output;
            status;
            artifacts = content_artifacts @ location_artifacts;
          }))

let decode_permission_option path json =
  let* fields = assoc path json in
  let* option_id = field_as fields path "optionId" nonempty_string in
  let* name = field_as fields path "name" nonempty_string in
  let* kind = field_as fields path "kind" nonempty_string in
  Ok { option_id; name; kind }

let decode_permission_tool path json =
  let* fields = assoc path json in
  let* tool_call_id = field_as fields path "toolCallId" nonempty_string in
  let* title = field_as fields path "title" nonempty_string in
  let* kind = field_as fields path "kind" nonempty_string in
  let* status = field_as fields path "status" tool_status in
  let raw_input = List.Assoc.find fields ~equal:String.equal "rawInput" in
  Ok { tool_call_id; title; kind; status; raw_input }

let decode_permission_requested path sequence payload =
  let* fields = assoc path payload in
  let* jsonrpc = field_as fields path "jsonrpc" string in
  if not (String.equal jsonrpc "2.0") then
    error (path ^ ".jsonrpc") "must be 2.0"
  else
    let* request_id = field_as fields path "id" id_string in
    let* method_ = field_as fields path "method" string in
    if not (String.equal method_ "session/request_permission") then
      error (path ^ ".method") "must be session/request_permission"
    else
      let* params = field_as fields path "params" assoc in
      let params_path = path ^ ".params" in
      let* session_id =
        field_as params params_path "sessionId" nonempty_string
      in
      let* tool_json = field params params_path "toolCall" in
      let* tool =
        decode_permission_tool (params_path ^ ".toolCall") tool_json
      in
      let* option_values = field_as params params_path "options" list in
      let* options =
        option_values
        |> List.mapi ~f:(fun index option ->
            decode_permission_option
              (Printf.sprintf "%s.options[%d]" params_path index)
              option)
        |> Result.all
      in
      if List.is_empty options then
        error (params_path ^ ".options") "must not be empty"
      else
        Ok
          (Some
             (Timeline_projection.Permission_requested_update
                {
                  sequence;
                  request = { request_id; session_id; tool; options };
                }))

let decode_permission_resolved path sequence payload =
  let* fields = assoc path payload in
  let* request_id = field_as fields path "requestId" nonempty_string in
  let* option_id =
    match List.Assoc.find fields ~equal:String.equal "optionId" with
    | Some `Null -> Ok None
    | Some json ->
        Result.map (nonempty_string (path ^ ".optionId") json) ~f:Option.some
    | None -> error (path ^ ".optionId") "is required"
  in
  Ok
    (Some
       (Timeline_projection.Permission_resolved_update
          { sequence; request_id; option_id }))

let decode_permission_cancelled path sequence payload =
  let* fields = assoc path payload in
  let* request_id = field_as fields path "requestId" nonempty_string in
  Ok
    (Some
       (Timeline_projection.Permission_cancelled_update { sequence; request_id }))

let decode_event_json index json =
  let path = Printf.sprintf "events[%d]" index in
  let* fields = assoc path json in
  let* sequence = field_as fields path "sequence" int64 in
  let* kind = field_as fields path "kind" nonempty_string in
  let* payload = field fields path "payload" in
  let* _payload_fields = assoc (path ^ ".payload") payload in
  let* _created_at = field_as fields path "createdAt" number in
  let payload_path = path ^ ".payload" in
  let* update =
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
    | "acp.permission.requested" ->
        decode_permission_requested payload_path sequence payload
    | "acp.permission.resolved" ->
        decode_permission_resolved payload_path sequence payload
    | "acp.permission.cancelled" ->
        decode_permission_cancelled payload_path sequence payload
    | _ -> Ok None
  in
  if Int64.(sequence <= 0L) then error (path ^ ".sequence") "must be positive"
  else Ok { sequence; kind; update }

let validate_order events =
  let rec loop previous = function
    | [] -> Ok events
    | event :: rest ->
        if Int64.(event.sequence <= previous) then
          Error "event sequences must be strictly increasing"
        else loop event.sequence rest
  in
  loop Int64.min_value events

let decode_events body =
  match Result.try_with (fun () -> Yojson.Safe.from_string body) with
  | Error exn -> Error ("response is not valid JSON: " ^ Exn.to_string exn)
  | Ok (`List events) ->
      let* decoded = events |> List.mapi ~f:decode_event_json |> Result.all in
      validate_order decoded
  | Ok _ -> Error "response must be a JSON array"

let decode_event body =
  match Result.try_with (fun () -> Yojson.Safe.from_string body) with
  | Error exn -> Error ("event is not valid JSON: " ^ Exn.to_string exn)
  | Ok json -> decode_event_json 0 json

let project events =
  events
  |> List.filter_map ~f:(fun event -> event.update)
  |> Timeline_projection.project

let decode body = Result.map (decode_events body) ~f:project
let sequence event = event.sequence
let kind event = event.kind

let refreshes_session event =
  String.equal event.kind "command.state"
  || String.is_prefix event.kind ~prefix:"acp.permission."

let command_is_terminal ~command_id entries =
  List.exists entries ~f:(function
    | Command_state { command_id = candidate; state; _ }
      when String.equal command_id candidate -> (
        match state with
        | Completed | Cancelled | Ambiguous | Rejected -> true
        | Received | Accepted | Dispatched | Acknowledged -> false)
    | _ -> false)

let pending_permissions entries =
  let requests = Hashtbl.create (module String) in
  List.iter entries ~f:(function
    | Permission_requested { sequence; request } ->
        Hashtbl.set requests ~key:request.request_id ~data:{ sequence; request }
    | Permission_resolved { request_id; _ }
    | Permission_cancelled { request_id; _ } ->
        Hashtbl.remove requests request_id
    | User _ | Agent _ | Tool _ | Command_state _ -> ());
  Hashtbl.data requests
  |> List.sort
       ~compare:(fun (left : pending_permission) (right : pending_permission) ->
         Int64.compare left.sequence right.sequence)
