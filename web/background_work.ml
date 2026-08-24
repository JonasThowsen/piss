open! Core

let ( let* ) result f = Result.bind result ~f
let error path message = Error (path ^ " " ^ message)

let assoc path = function
  | `Assoc fields -> Ok fields
  | _ -> error path "must be an object"

let field fields path name =
  match List.Assoc.find fields ~equal:String.equal name with
  | Some value -> Ok value
  | None -> error (path ^ "." ^ name) "is required"

let field_as fields path name decode =
  let* value = field fields path name in
  decode (path ^ "." ^ name) value

let optional_field fields path name decode =
  match List.Assoc.find fields ~equal:String.equal name with
  | None | Some `Null -> Ok None
  | Some value -> Result.map (decode (path ^ "." ^ name) value) ~f:Option.some

let bounded_string path = function
  | `String value
    when (not (String.is_empty value))
         && String.length value <= 160
         && not (String.mem value '\000') ->
      Ok value
  | `String _ -> error path "must be 1-160 characters without NUL"
  | _ -> error path "must be a string"

let nonnegative_int path = function
  | `Int value when value >= 0 -> Ok value
  | `Intlit value -> (
      match Int.of_string_opt value with
      | Some value when value >= 0 -> Ok value
      | Some _ | None -> error path "must be a non-negative integer")
  | _ -> error path "must be a non-negative integer"

let nonnegative_int64 path = function
  | `Int value when value >= 0 -> Ok (Int64.of_int value)
  | `Intlit value -> (
      match Int64.of_string_opt value with
      | Some value when Int64.(value >= 0L) -> Ok value
      | Some _ | None -> error path "must be a non-negative integer")
  | _ -> error path "must be a non-negative integer"

type state =
  | Queued
  | Running
  | Complete
  | Failed
  | Paused
  | Stopped
  | Rejected

let state path json =
  let* value = bounded_string path json in
  match value with
  | "queued" -> Ok Queued
  | "running" -> Ok Running
  | "complete" -> Ok Complete
  | "failed" -> Ok Failed
  | "paused" -> Ok Paused
  | "stopped" -> Ok Stopped
  | "rejected" -> Ok Rejected
  | _ -> error path ("has unsupported value " ^ value)

let state_to_string = function
  | Queued -> "queued"
  | Running -> "running"
  | Complete -> "complete"
  | Failed -> "failed"
  | Paused -> "paused"
  | Stopped -> "stopped"
  | Rejected -> "rejected"

let is_running = function Queued | Running -> true | _ -> false

type kind = Subagent | Workflow | Step

let kind path json =
  let* value = bounded_string path json in
  match value with
  | "subagent" -> Ok Subagent
  | "workflow" -> Ok Workflow
  | "step" -> Ok Step
  | _ -> error path ("has unsupported value " ^ value)

let kind_to_string = function
  | Subagent -> "subagent"
  | Workflow -> "workflow"
  | Step -> "step"

type activity = {
  state : string option;
  current_tool : string option;
  turn_count : int option;
  tool_count : int option;
}

let activity path json =
  let* fields = assoc path json in
  let* state = optional_field fields path "state" bounded_string in
  let* current_tool = optional_field fields path "currentTool" bounded_string in
  let* turn_count = optional_field fields path "turnCount" nonnegative_int in
  let* tool_count = optional_field fields path "toolCount" nonnegative_int in
  Ok { state; current_tool; turn_count; tool_count }

type node = {
  id : string;
  kind : kind;
  label : string;
  state : state;
  activity : activity option;
  children : node list;
}

let rec node ~depth path json =
  if depth > 3 then error path "exceeds maximum depth 3"
  else
    let* fields = assoc path json in
    let* id = field_as fields path "id" bounded_string in
    let* kind = field_as fields path "kind" kind in
    let* label = field_as fields path "label" bounded_string in
    let* state = field_as fields path "state" state in
    let* activity = optional_field fields path "activity" activity in
    let* children =
      match List.Assoc.find fields ~equal:String.equal "children" with
      | None | Some `Null -> Ok []
      | Some (`List values) when List.length values <= 8 ->
          values
          |> List.mapi ~f:(fun index value ->
              node ~depth:(depth + 1)
                (Printf.sprintf "%s.children[%d]" path index)
                value)
          |> Result.all
      | Some (`List _) ->
          error (path ^ ".children") "must contain at most 8 nodes"
      | Some _ -> error (path ^ ".children") "must be an array"
    in
    Ok { id; kind; label; state; activity; children }

type t = {
  generated_at : int64;
  omitted_runs : int;
  omitted_children : int;
  runs : node list;
}

let decode ~path json =
  if String.length (Yojson.Safe.to_string json) > 32 * 1024 then
    error path "must not exceed 32 KiB"
  else
    let* fields = assoc path json in
    let* kind = field_as fields path "kind" bounded_string in
    if not (String.equal kind "pi-subagents.async-status-snapshot") then
      error (path ^ ".kind") "must be pi-subagents.async-status-snapshot"
    else
      let* version = field_as fields path "version" nonnegative_int in
      if version <> 1 then error (path ^ ".version") "must be 1"
      else
        let* generated_at =
          field_as fields path "generatedAt" nonnegative_int64
        in
        let* omitted = field_as fields path "omitted" assoc in
        let omitted_path = path ^ ".omitted" in
        let* omitted_runs =
          field_as omitted omitted_path "runs" nonnegative_int
        in
        let* omitted_children =
          field_as omitted omitted_path "children" nonnegative_int
        in
        let* runs =
          match List.Assoc.find fields ~equal:String.equal "runs" with
          | Some (`List values) when List.length values <= 20 ->
              values
              |> List.mapi ~f:(fun index value ->
                  node ~depth:0 (Printf.sprintf "%s.runs[%d]" path index) value)
              |> Result.all
          | Some (`List _) ->
              error (path ^ ".runs") "must contain at most 20 nodes"
          | Some _ -> error (path ^ ".runs") "must be an array"
          | None -> error (path ^ ".runs") "is required"
        in
        Ok { generated_at; omitted_runs; omitted_children; runs }
