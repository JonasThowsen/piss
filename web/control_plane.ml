open! Core

module Session = struct
  type harness = Pi | Opencode | Mock | Other of string

  type status =
    | Starting
    | Idle
    | Running
    | Requires_action
    | Stopped
    | Failed
    | Offline
    | Archived

  type runtime = {
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
  }

  type t = {
    id : string;
    title : string;
    harness : harness;
    workspace_id : string;
    created_at : float;
    archived_at : float option;
    status : status;
    runtime : runtime option;
  }

  let harness_to_string = function
    | Pi -> "pi"
    | Opencode -> "opencode"
    | Mock -> "mock"
    | Other value -> value

  let status_to_string = function
    | Starting -> "starting"
    | Idle -> "idle"
    | Running -> "running"
    | Requires_action -> "requires_action"
    | Stopped -> "stopped"
    | Failed -> "failed"
    | Offline -> "offline"
    | Archived -> "archived"
end

let error path expected = Error (path ^ " " ^ expected)

let field fields path name =
  match List.Assoc.find fields ~equal:String.equal name with
  | Some value -> Ok value
  | None -> error (path ^ "." ^ name) "is required"

let string path = function
  | `String value -> Ok value
  | _ -> error path "must be a string"

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

let number path = function
  | `Int value -> Ok (Float.of_int value)
  | `Intlit value -> (
      match Float.of_string_opt value with
      | Some value when Float.is_finite value -> Ok value
      | _ -> error path "must be a finite number")
  | `Float value when Float.is_finite value -> Ok value
  | _ -> error path "must be a finite number"

let nullable decode path = function
  | `Null -> Ok None
  | value -> Result.map (decode path value) ~f:Option.some

let harness path value =
  match value with
  | `String "pi" -> Ok Session.Pi
  | `String "opencode" -> Ok Session.Opencode
  | `String "mock" -> Ok Session.Mock
  | `String "" -> error path "must not be empty"
  | `String value -> Ok (Session.Other value)
  | _ -> error path "must be a string"

let status path value =
  match value with
  | `String "starting" -> Ok Session.Starting
  | `String "idle" -> Ok Session.Idle
  | `String "running" -> Ok Session.Running
  | `String "requires_action" -> Ok Session.Requires_action
  | `String "stopped" -> Ok Session.Stopped
  | `String "failed" -> Ok Session.Failed
  | `String "offline" -> Ok Session.Offline
  | `String "archived" -> Ok Session.Archived
  | `String value -> error path ("has unsupported value " ^ value)
  | _ -> error path "must be a string"

let bind_field fields path name decode f =
  Result.bind (field fields path name) ~f:(fun value ->
      Result.bind (decode (path ^ "." ^ name) value) ~f)

let decode_runtime fields path session_id runtime_status =
  bind_field fields path "sessionId" string (fun snapshot_session_id ->
      if not (String.equal session_id snapshot_session_id) then
        error (path ^ ".sessionId") "must match id"
      else
        bind_field fields path "workerId" string (fun worker_id ->
            bind_field fields path "workerGeneration" string
              (fun worker_generation ->
                bind_field fields path "runtimeGeneration" int
                  (fun runtime_generation ->
                    bind_field fields path "workerPid" int (fun worker_pid ->
                        bind_field fields path "harnessPid" (nullable int)
                          (fun harness_pid ->
                            bind_field fields path "agentName" string
                              (fun agent_name ->
                                bind_field fields path "firstSequence" int64
                                  (fun first_sequence ->
                                    bind_field fields path "lastSequence" int64
                                      (fun last_sequence ->
                                        bind_field fields path "retentionPruned"
                                          bool (fun retention_pruned ->
                                            bind_field fields path
                                              "upgradePending" bool
                                              (fun upgrade_pending ->
                                                bind_field fields path
                                                  "acceptsImages" bool
                                                  (fun accepts_images ->
                                                    Ok
                                                      {
                                                        Session.worker_id;
                                                        worker_generation;
                                                        runtime_generation;
                                                        worker_pid;
                                                        harness_pid;
                                                        agent_name;
                                                        status = runtime_status;
                                                        first_sequence;
                                                        last_sequence;
                                                        retention_pruned;
                                                        upgrade_pending;
                                                        accepts_images;
                                                      }))))))))))))

let decode_session index = function
  | `Assoc fields ->
      let path = Printf.sprintf "sessions[%d]" index in
      bind_field fields path "id" string (fun id ->
          bind_field fields path "title" string (fun title ->
              bind_field fields path "harness" harness (fun harness ->
                  bind_field fields path "workspaceId" string
                    (fun workspace_id ->
                      bind_field fields path "createdAt" number
                        (fun created_at ->
                          bind_field fields path "archivedAt" (nullable number)
                            (fun archived_at ->
                              bind_field fields path "status" status
                                (fun runtime_status ->
                                  let finish runtime =
                                    Ok
                                      {
                                        Session.id;
                                        title;
                                        harness;
                                        workspace_id;
                                        created_at;
                                        archived_at;
                                        status = runtime_status;
                                        runtime;
                                      }
                                  in
                                  match runtime_status with
                                  | Session.Offline | Session.Archived ->
                                      finish None
                                  | _ ->
                                      Result.bind
                                        (decode_runtime fields path id
                                           runtime_status) ~f:(fun runtime ->
                                          finish (Some runtime)))))))))
  | _ -> error (Printf.sprintf "sessions[%d]" index) "must be an object"

let decode_sessions body =
  match Result.try_with (fun () -> Yojson.Safe.from_string body) with
  | Error exn -> Error ("response is not valid JSON: " ^ Exn.to_string exn)
  | Ok (`List sessions) -> sessions |> List.mapi ~f:decode_session |> Result.all
  | Ok _ -> Error "response must be a JSON array"
