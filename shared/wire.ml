open Domain

let max_prompt_images = 4
let max_prompt_image_bytes = 10 * 1024 * 1024

let supported_image_mime_types =
  [ "image/png"; "image/jpeg"; "image/gif"; "image/webp" ]

type request =
  | Hello of { protocol_version : int }
  | Snapshot
  | Prepare_upgrade of { generation : string }
  | Events of { after : int64; limit : int }
  | Wait_events of { after : int64; limit : int; timeout_ms : int }
  | Events_before of { before : int64; limit : int }
  | Recent_events of { limit : int }
  | File_search of { query : string }
  | New_session
  | Prompt of {
      target : runtime_target;
      command_id : string;
      text : string;
      images : image_input list;
      resources : resource_input list;
    }
  | Deliver of {
      target : runtime_target;
      command_id : string;
      text : string;
      images : image_input list;
      resources : resource_input list;
      action : string;
    }
  | Recover_command of {
      target : runtime_target;
      command_id : string;
      action : string;
      discard_cleared_attachments : bool;
    }
  | Cancel of { target : runtime_target; mutation_id : string }
  | Config_options
  | Set_config_option of {
      target : runtime_target;
      mutation_id : string;
      config_id : string;
      value : string;
    }
  | Permission of {
      target : runtime_target;
      mutation_id : string;
      request_id : string;
      option_id : string option;
    }
  | Peer_event of {
      kind : string;
      request_id : string;
      peer_id : string;
      text : string;
    }

type response = (Yojson.Safe.t, Error.t) result

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

let bounded_identity ~field ~max value =
  if value = "" || String.length value > max then
    Error
      (Printf.sprintf "%s must contain between 1 and %d characters" field max)
  else if String.contains value '\000' then
    Error (field ^ " must not contain NUL")
  else Ok value

let runtime_target_member json =
  match member "target" json with
  | `Assoc _ as target ->
      let* session_id = string_member "sessionId" target in
      let* session_id =
        bounded_identity ~field:"target.sessionId" ~max:128 session_id
      in
      let* worker_id = string_member "workerId" target in
      let* worker_id =
        bounded_identity ~field:"target.workerId" ~max:128 worker_id
      in
      let* runtime_generation = int_member "runtimeGeneration" target in
      if runtime_generation < 0 then
        Error "target.runtimeGeneration must be non-negative"
      else
        Ok
          {
            session_id = Domain.session_id session_id;
            worker_id = Domain.worker_id worker_id;
            runtime_generation = Domain.runtime_generation runtime_generation;
          }
  | _ -> Error "target must be an object"

let mutation_id_member json =
  let* mutation_id = string_member "mutationId" json in
  bounded_identity ~field:"mutationId" ~max:128 mutation_id

let is_base64_character = function
  | 'A' .. 'Z' | 'a' .. 'z' | '0' .. '9' | '+' | '/' -> true
  | _ -> false

let decoded_base64_size data =
  let length = String.length data in
  if length = 0 || length mod 4 <> 0 then Error "image data must be base64"
  else
    let padding =
      if length >= 2 && data.[length - 2] = '=' then 2
      else if data.[length - 1] = '=' then 1
      else 0
    in
    let payload_length = length - padding in
    let rec valid index =
      if index = payload_length then true
      else if is_base64_character data.[index] then valid (index + 1)
      else false
    in
    let rec valid_padding index =
      if index = length then true
      else if data.[index] = '=' then valid_padding (index + 1)
      else false
    in
    if not (valid 0 && valid_padding payload_length) then
      Error "image data must be base64"
    else Ok ((length / 4 * 3) - padding)

let image_of_yojson json =
  let* mime_type = string_member "mimeType" json in
  let* data = string_member "data" json in
  let name =
    match member "name" json with
    | `String value when value <> "" -> value
    | _ -> "Pasted image"
  in
  if not (List.exists (String.equal mime_type) supported_image_mime_types) then
    Error ("unsupported image type: " ^ mime_type)
  else if String.length name > 255 || String.contains name '\000' then
    Error "image name is invalid"
  else
    let* size = decoded_base64_size data in
    Ok { mime_type; data; name; size }

let images_member json =
  match member "images" json with
  | `Null -> Ok []
  | `List values ->
      if List.length values > max_prompt_images then
        Error "at most four images may be attached"
      else
        let rec collect total images = function
          | [] -> Ok (List.rev images)
          | value :: remaining ->
              let* image = image_of_yojson value in
              let total = total + image.size in
              if total > max_prompt_image_bytes then
                Error "image attachments exceed the 10 MiB limit"
              else collect total (image :: images) remaining
        in
        collect 0 [] values
  | _ -> Error "images must be an array"

let image_to_yojson image =
  `Assoc
    [
      ("mimeType", `String image.mime_type);
      ("data", `String image.data);
      ("name", `String image.name);
    ]

let image_metadata_to_yojson image =
  `Assoc
    [
      ("mimeType", `String image.mime_type);
      ("name", `String image.name);
      ("size", `Int image.size);
    ]

let resource_of_yojson json =
  let* path = string_member "path" json in
  if path = "" || String.length path > Workspace_files.max_path_bytes then
    Error "resource path must contain between 1 and 16384 characters"
  else if not (Workspace_files.valid_relative_path path) then
    Error "resource path must be canonical and workspace-relative"
  else Ok { path }

let resources_member json =
  match member "resources" json with
  | `Null -> Ok []
  | `List values ->
      if List.length values > 16 then
        Error "at most sixteen files may be mentioned"
      else
        let rec collect resources = function
          | [] -> Ok (List.rev resources)
          | value :: remaining ->
              let* resource = resource_of_yojson value in
              if
                List.exists
                  (fun current -> current.path = resource.path)
                  resources
              then collect resources remaining
              else collect (resource :: resources) remaining
        in
        collect [] values
  | _ -> Error "resources must be an array"

let resource_to_yojson resource = `Assoc [ ("path", `String resource.path) ]

let validate_prompt ~empty_message ~text ~images ~resources =
  if text = "" && images = [] && resources = [] then Error empty_message
  else if String.length text > 64 * 1024 then Error "prompt is too large"
  else Ok ()

let request_of_yojson json =
  let* operation = string_member "op" json in
  match operation with
  | "hello" ->
      let* protocol_version = int_member "protocolVersion" json in
      Ok (Hello { protocol_version })
  | "snapshot" -> Ok Snapshot
  | "prepare_upgrade" ->
      let* generation = string_member "generation" json in
      if generation = "" || String.length generation > 256 then
        Error "generation must contain between 1 and 256 characters"
      else if String.contains generation '\000' then
        Error "generation must not contain NUL"
      else Ok (Prepare_upgrade { generation })
  | "events" ->
      let* after = int64_member ~default:0L "after" json in
      let* limit = int_member ~default:200 "limit" json in
      if limit < 1 || limit > 500 then Error "limit must be between 1 and 500"
      else Ok (Events { after; limit })
  | "wait_events" ->
      let* after = int64_member ~default:0L "after" json in
      let* limit = int_member ~default:200 "limit" json in
      let* timeout_ms = int_member ~default:15_000 "timeoutMs" json in
      if limit < 1 || limit > 500 then Error "limit must be between 1 and 500"
      else if timeout_ms < 1 || timeout_ms > 15_000 then
        Error "timeoutMs must be between 1 and 15000"
      else Ok (Wait_events { after; limit; timeout_ms })
  | "events_before" ->
      let* before = int64_member "before" json in
      let* limit = int_member ~default:200 "limit" json in
      if before <= 0L then Error "before must be a positive integer"
      else if limit < 1 || limit > 500 then
        Error "limit must be between 1 and 500"
      else Ok (Events_before { before; limit })
  | "recent_events" ->
      let* limit = int_member ~default:500 "limit" json in
      if limit < 1 || limit > 500 then Error "limit must be between 1 and 500"
      else Ok (Recent_events { limit })
  | "file_search" ->
      let* query = string_member "query" json in
      if String.length query > 200 then Error "file mention query is too long"
      else if String.contains query '\000' then
        Error "file mention query must not contain NUL"
      else Ok (File_search { query })
  | "new_session" -> Ok New_session
  | "prompt" ->
      let* target = runtime_target_member json in
      let* command_id = string_member "commandId" json in
      let* text = string_member "text" json in
      let* images = images_member json in
      let* resources = resources_member json in
      if command_id = "" then Error "commandId must not be empty"
      else if String.length command_id > 128 then Error "commandId is too long"
      else
        let* () =
          validate_prompt
            ~empty_message:"prompt must contain text, an image, or a resource"
            ~text ~images ~resources
        in
        Ok (Prompt { target; command_id; text; images; resources })
  | "deliver" ->
      let* target = runtime_target_member json in
      let* command_id = string_member "commandId" json in
      let* text = string_member "text" json in
      let* images = images_member json in
      let* resources = resources_member json in
      let* action = string_member "action" json in
      if command_id = "" then Error "commandId must not be empty"
      else if String.length command_id > 128 then Error "commandId is too long"
      else if action <> "steer" && action <> "follow_up" then
        Error "delivery action must be steer or follow_up"
      else
        let* () =
          validate_prompt
            ~empty_message:"delivery must contain text, an image, or a resource"
            ~text ~images ~resources
        in
        Ok (Deliver { target; command_id; text; images; resources; action })
  | "recover_command" ->
      let* target = runtime_target_member json in
      let* command_id = string_member "commandId" json in
      let* action = string_member "action" json in
      let* discard_cleared_attachments =
        match member "discardClearedAttachments" json with
        | `Null -> Ok false
        | `Bool value -> Ok value
        | _ -> Error "discardClearedAttachments must be a boolean"
      in
      if command_id = "" || String.length command_id > 128 then
        Error "commandId must contain between 1 and 128 characters"
      else if action <> "prompt" && action <> "follow_up" then
        Error "recovery action must be prompt or follow_up"
      else
        Ok
          (Recover_command
             { target; command_id; action; discard_cleared_attachments })
  | "cancel" ->
      let* target = runtime_target_member json in
      let* mutation_id = mutation_id_member json in
      Ok (Cancel { target; mutation_id })
  | "config_options" -> Ok Config_options
  | "set_config_option" ->
      let* target = runtime_target_member json in
      let* mutation_id = mutation_id_member json in
      let* config_id = string_member "configId" json in
      let* value = string_member "value" json in
      if config_id = "" || String.length config_id > 128 then
        Error "configId must contain between 1 and 128 characters"
      else if value = "" || String.length value > 512 then
        Error "value must contain between 1 and 512 characters"
      else Ok (Set_config_option { target; mutation_id; config_id; value })
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
               "session.ask.queued";
               "session.ask.dispatched";
               "session.ask.received";
               "session.ask.completed";
               "session.ask.failed";
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
      let* target = runtime_target_member json in
      let* mutation_id = mutation_id_member json in
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
      else Ok (Permission { target; mutation_id; request_id; option_id })
  | value -> Error ("unknown operation: " ^ value)

let request_of_yojson_v1 ~(target : runtime_target) ~mutation_id json =
  let target_json =
    `Assoc
      [
        ("sessionId", `String (session_id_to_string target.session_id));
        ("workerId", `String (worker_id_to_string target.worker_id));
        ( "runtimeGeneration",
          `Int (runtime_generation_to_int target.runtime_generation) );
      ]
  in
  let with_fields fields =
    match json with
    | `Assoc existing -> `Assoc (fields @ existing)
    | value -> value
  in
  match (member "op" json, member "target" json) with
  | `String _, `Assoc _ -> request_of_yojson json
  | `String ("prompt" | "deliver"), _ ->
      request_of_yojson (with_fields [ ("target", target_json) ])
  | `String ("cancel" | "set_config_option" | "permission"), _ ->
      request_of_yojson
        (with_fields
           [ ("target", target_json); ("mutationId", `String mutation_id) ])
  | _ -> request_of_yojson json

let response_to_yojson = function
  | Ok result -> `Assoc [ ("ok", `Bool true); ("result", result) ]
  | Error error ->
      `Assoc [ ("ok", `Bool false); ("error", Error.to_yojson error) ]

let response_of_yojson json =
  match member "ok" json with
  | `Bool true -> Ok (member "result" json)
  | `Bool false -> (
      match Error.of_yojson (member "error" json) with
      | Ok error -> Error error
      | Error message ->
          Error
            (Error.Internal
               { message = "worker returned an invalid error: " ^ message }))
  | _ -> Error (Error.Internal { message = "worker response is missing ok" })
