open! Core

type status =
  | Starting
  | Idle
  | Waiting
  | Running
  | Requires_action
  | Stopped
  | Failed
  | Offline
  | Archived

type choice = { value : string; name : string; description : string option }

type config_option = {
  config_id : string;
  category : string;
  name : string;
  description : string option;
  current_value : string;
  choices : choice list;
}

type available_command = {
  name : string;
  description : string;
  input_hint : string option;
}

type t = {
  session_id : string;
  worker_id : string;
  worker_generation : string;
  runtime_generation : int;
  worker_pid : int;
  harness_pid : int option;
  agent_name : string;
  status : status;
  first_sequence : int64;
  last_sequence : int64;
  retention_pruned : bool;
  upgrade_pending : bool;
  accepts_images : bool;
  config_options : config_option list;
  available_commands : available_command list;
}

let ( let* ) result f = Result.bind result ~f
let error path expected = Error (path ^ " " ^ expected)

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

let bool path = function
  | `Bool value -> Ok value
  | _ -> error path "must be a boolean"

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

let nullable decode path = function
  | `Null -> Ok None
  | value -> Result.map (decode path value) ~f:Option.some

let optional_field fields path name decode =
  match List.Assoc.find fields ~equal:String.equal name with
  | None | Some `Null -> Ok None
  | Some value -> Result.map (decode (path ^ "." ^ name) value) ~f:Option.some

let field_as fields path name decode =
  let* value = field fields path name in
  decode (path ^ "." ^ name) value

let list_as fields path name decode =
  let* values = field fields path name in
  match values with
  | `List values ->
      values
      |> List.mapi ~f:(fun index value ->
          decode (Printf.sprintf "%s.%s[%d]" path name index) value)
      |> Result.all
  | _ -> error (path ^ "." ^ name) "must be an array"

let status_to_string = function
  | Starting -> "starting"
  | Idle -> "idle"
  | Waiting -> "waiting"
  | Running -> "running"
  | Requires_action -> "requires_action"
  | Stopped -> "stopped"
  | Failed -> "failed"
  | Offline -> "offline"
  | Archived -> "archived"

let status_label = function
  | Waiting -> "waiting on delegated work"
  | status -> status_to_string status

let status path json =
  let* value = string path json in
  match value with
  | "starting" -> Ok Starting
  | "idle" -> Ok Idle
  | "waiting" -> Ok Waiting
  | "running" -> Ok Running
  | "requires_action" -> Ok Requires_action
  | "stopped" -> Ok Stopped
  | "failed" -> Ok Failed
  | "offline" -> Ok Offline
  | "archived" -> Ok Archived
  | value -> error path ("has unsupported value " ^ value)

let decode_choice path json =
  let* fields = assoc path json in
  let* value = field_as fields path "value" nonempty_string in
  let* name = field_as fields path "name" nonempty_string in
  let* description = optional_field fields path "description" string in
  Ok { value; name; description }

let decode_config_option path json =
  let* fields = assoc path json in
  let* type_ = field_as fields path "type" string in
  if not (String.equal type_ "select") then
    error (path ^ ".type") "must be select"
  else
    let* config_id = field_as fields path "id" nonempty_string in
    let* category = field_as fields path "category" nonempty_string in
    let* name = field_as fields path "name" nonempty_string in
    let* description = optional_field fields path "description" string in
    let* current_value = field_as fields path "currentValue" nonempty_string in
    let* choices = list_as fields path "options" decode_choice in
    if List.is_empty choices then error (path ^ ".options") "must not be empty"
    else if
      not
        (List.exists choices ~f:(fun choice ->
             String.equal choice.value current_value))
    then error (path ^ ".currentValue") "must match an option value"
    else Ok { config_id; category; name; description; current_value; choices }

let decode_config_options fields path =
  list_as fields path "configOptions" decode_config_option

let bounded_nonempty_string ~limit path json =
  let* value = nonempty_string path json in
  if String.length value > limit || String.contains value '\000' then
    error path
      (Printf.sprintf "must contain at most %d non-NUL characters" limit)
  else Ok value

let decode_available_command path json =
  let* fields = assoc path json in
  let* name =
    field_as fields path "name" (bounded_nonempty_string ~limit:128)
  in
  let* description =
    field_as fields path "description" (bounded_nonempty_string ~limit:512)
  in
  let* input_hint =
    optional_field fields path "input" (fun input_path input ->
        let* input = assoc input_path input in
        optional_field input input_path "hint"
          (bounded_nonempty_string ~limit:256))
  in
  Ok { name; description; input_hint = Option.join input_hint }

let decode_available_commands fields path =
  match List.Assoc.find fields ~equal:String.equal "availableCommands" with
  | None | Some `Null -> Ok []
  | Some (`List commands) ->
      if List.length commands > 128 then
        error (path ^ ".availableCommands") "must contain at most 128 commands"
      else
        commands
        |> List.mapi ~f:(fun index command ->
            decode_available_command
              (Printf.sprintf "%s.availableCommands[%d]" path index)
              command)
        |> Result.all
  | Some _ -> error (path ^ ".availableCommands") "must be an array"

let decode_json ~path ~expected_session json =
  let* fields = assoc path json in
  let* session_id = field_as fields path "sessionId" nonempty_string in
  if not (String.equal session_id expected_session) then
    error (path ^ ".sessionId") "must match id"
  else
    let* worker_id = field_as fields path "workerId" nonempty_string in
    let* worker_generation =
      field_as fields path "workerGeneration" nonempty_string
    in
    let* runtime_generation = field_as fields path "runtimeGeneration" int in
    let* worker_pid = field_as fields path "workerPid" int in
    let* harness_pid = field_as fields path "harnessPid" (nullable int) in
    let* agent_name = field_as fields path "agentName" nonempty_string in
    let* status = field_as fields path "status" status in
    let* first_sequence = field_as fields path "firstSequence" int64 in
    let* last_sequence = field_as fields path "lastSequence" int64 in
    let* retention_pruned = field_as fields path "retentionPruned" bool in
    let* upgrade_pending = field_as fields path "upgradePending" bool in
    let* accepts_images = field_as fields path "acceptsImages" bool in
    let* config_options = decode_config_options fields path in
    let* available_commands = decode_available_commands fields path in
    if runtime_generation < 0 then
      error (path ^ ".runtimeGeneration") "must be non-negative"
    else if worker_pid <= 0 then error (path ^ ".workerPid") "must be positive"
    else if Int64.(first_sequence < 0L || last_sequence < first_sequence) then
      error path "contains an invalid retained sequence range"
    else
      Ok
        {
          session_id;
          worker_id;
          worker_generation;
          runtime_generation;
          worker_pid;
          harness_pid;
          agent_name;
          status;
          first_sequence;
          last_sequence;
          retention_pruned;
          upgrade_pending;
          accepts_images;
          config_options;
          available_commands;
        }

let parse body =
  match Result.try_with (fun () -> Yojson.Safe.from_string body) with
  | Ok json -> Ok json
  | Error exn -> Error ("response is not valid JSON: " ^ Exn.to_string exn)

let decode ~expected_session body =
  let* json = parse body in
  decode_json ~path:"session" ~expected_session json

let decode_config_response body =
  let* json = parse body in
  let* fields = assoc "response" json in
  decode_config_options fields "response"

let find_category runtime category =
  List.find runtime.config_options ~f:(fun option ->
      String.equal option.category category)

let target_to_yojson runtime =
  `Assoc
    [
      ("sessionId", `String runtime.session_id);
      ("workerId", `String runtime.worker_id);
      ("runtimeGeneration", `Int runtime.runtime_generation);
    ]

let mutation_to_yojson runtime ~mutation_id fields =
  `Assoc
    (("target", target_to_yojson runtime)
    :: ("mutationId", `String mutation_id)
    :: fields)

let config_change_to_yojson runtime ~mutation_id ~config_id ~value =
  mutation_to_yojson runtime ~mutation_id
    [ ("configId", `String config_id); ("value", `String value) ]
