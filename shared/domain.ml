(* Pure domain types for the Piss control plane, worker, and browser shell. See
   [domain.mli] for the design notes. *)

type session_id = Session_id of string
type worker_id = Worker_id of string
type runtime_generation = Runtime_generation of int
type command_id = Command_id of string
type request_id = Request_id of string
type subscription_id = Subscription_id of string

let bounded_id ~label ~max value wrap =
  if value = "" || String.length value > max then
    Error
      (Printf.sprintf "%s must contain between 1 and %d characters" label max)
  else if String.contains value '\000' then
    Error (label ^ " must not contain NUL")
  else Ok (wrap value)

module Session_id = struct
  type t = session_id

  let of_string value =
    bounded_id ~label:"sessionId" ~max:128 value (fun value -> Session_id value)

  let to_string (Session_id value) = value
end

module Worker_id = struct
  type t = worker_id

  let of_string value =
    bounded_id ~label:"workerId" ~max:128 value (fun value -> Worker_id value)

  let to_string (Worker_id value) = value
end

module Runtime_generation = struct
  type t = runtime_generation

  let of_int value =
    if value < 0 then Error "runtimeGeneration must be non-negative"
    else Ok (Runtime_generation value)

  let to_int (Runtime_generation value) = value
end

module Command_id = struct
  type t = command_id

  let of_string value =
    bounded_id ~label:"commandId" ~max:128 value (fun value -> Command_id value)

  let to_string (Command_id value) = value
end

module Request_id = struct
  type t = request_id

  let of_string value =
    bounded_id ~label:"requestId" ~max:128 value (fun value -> Request_id value)

  let to_string (Request_id value) = value
end

module Subscription_id = struct
  type t = subscription_id

  let of_string value =
    bounded_id ~label:"subscriptionId" ~max:128 value (fun value ->
        Subscription_id value)

  let to_string (Subscription_id value) = value
end

let session_id_to_string = Session_id.to_string
let worker_id_to_string = Worker_id.to_string
let runtime_generation_to_int = Runtime_generation.to_int

type runtime_target = {
  session_id : session_id;
  worker_id : worker_id;
  runtime_generation : runtime_generation;
}

type command_state =
  | Received
  | Accepted
  | Dispatched
  | Acknowledged
  | Completed
  | Cancelled
  | Ambiguous
  | Rejected

type worker_status =
  | Starting
  | Idle
  | Waiting
  | Running
  | Requires_action
  | Stopped
  | Failed

type image_input = {
  mime_type : string;
  data : string;
  name : string;
  size : int;
}

type resource_input = { path : string }

type event = {
  sequence : int64;
  kind : string;
  payload : Yojson.Safe.t;
  created_at : float;
}

type snapshot = {
  session_id : session_id;
  worker_id : worker_id;
  runtime_generation : runtime_generation;
  worker_pid : int;
  harness_pid : int option;
  agent_name : string;
  status : worker_status;
  first_sequence : int64;
  last_sequence : int64;
  last_finished_at : float option;
  retention_pruned : bool;
}

let command_state_to_string = function
  | Received -> "received"
  | Accepted -> "accepted"
  | Dispatched -> "dispatched"
  | Acknowledged -> "acknowledged"
  | Completed -> "completed"
  | Cancelled -> "cancelled"
  | Ambiguous -> "ambiguous"
  | Rejected -> "rejected"

let command_state_of_string = function
  | "received" -> Ok Received
  | "accepted" -> Ok Accepted
  | "dispatched" -> Ok Dispatched
  | "acknowledged" -> Ok Acknowledged
  | "completed" -> Ok Completed
  | "cancelled" -> Ok Cancelled
  | "ambiguous" -> Ok Ambiguous
  | "rejected" -> Ok Rejected
  | value -> Error ("unknown command state: " ^ value)

let command_state_is_terminal = function
  | Completed | Cancelled | Ambiguous | Rejected -> true
  | Received | Accepted | Dispatched | Acknowledged -> false

let transition_command_state ~from into =
  match (from, into) with
  | Received, (Accepted | Rejected)
  | Accepted, (Dispatched | Cancelled | Ambiguous | Rejected)
  | Dispatched, (Acknowledged | Completed | Cancelled | Ambiguous | Rejected)
  | Acknowledged, (Completed | Cancelled | Ambiguous | Rejected) ->
      Ok into
  | left, right when left = right -> Ok right
  | left, right ->
      Error
        (Printf.sprintf "invalid command transition from %s to %s"
           (command_state_to_string left)
           (command_state_to_string right))

let reconcile_ambiguous_command_state = function
  | (Completed | Cancelled | Rejected) as state -> Ok state
  | Received | Accepted | Dispatched | Acknowledged | Ambiguous ->
      Error
        "ambiguous command reconciliation requires completed, cancelled, or \
         rejected ACP evidence"

let worker_status_to_string = function
  | Starting -> "starting"
  | Idle -> "idle"
  | Waiting -> "waiting"
  | Running -> "running"
  | Requires_action -> "requires_action"
  | Stopped -> "stopped"
  | Failed -> "failed"

let worker_status_of_string = function
  | "starting" -> Ok Starting
  | "idle" -> Ok Idle
  | "waiting" -> Ok Waiting
  | "running" -> Ok Running
  | "requires_action" -> Ok Requires_action
  | "stopped" -> Ok Stopped
  | "failed" -> Ok Failed
  | value -> Error ("unknown worker status: " ^ value)

let int64_of_json_exn field = function
  | `Int value -> Ok (Int64.of_int value)
  | `Intlit value -> (
      try Ok (Int64.of_string value)
      with Failure _ -> Error (field ^ " must be an integer"))
  | _ -> Error (field ^ " must be an integer")

let string_of_json_exn field = function
  | `String value -> Ok value
  | _ -> Error (field ^ " must be a string")

let bool_of_json_exn field = function
  | `Bool value -> Ok value
  | _ -> Error (field ^ " must be a boolean")

let float_of_json_exn field = function
  | `Float value -> Ok value
  | `Int value -> Ok (float_of_int value)
  | _ -> Error (field ^ " must be a number")

let event_to_yojson event =
  `Assoc
    [
      ("sequence", `Intlit (Int64.to_string event.sequence));
      ("kind", `String event.kind);
      ("payload", event.payload);
      ("createdAt", `Float event.created_at);
    ]

let event_of_yojson json =
  let open Yojson.Safe.Util in
  Result.bind
    (int64_of_json_exn "event.sequence" (member "sequence" json))
    (fun sequence ->
      Result.bind
        (string_of_json_exn "event.kind" (member "kind" json))
        (fun kind ->
          let payload =
            match member "payload" json with `Null -> `Null | value -> value
          in
          Result.bind
            (float_of_json_exn "event.createdAt" (member "createdAt" json))
            (fun created_at -> Ok { sequence; kind; payload; created_at })))

let snapshot_to_yojson snapshot =
  let (Session_id session_id) = snapshot.session_id in
  let (Worker_id worker_id) = snapshot.worker_id in
  let (Runtime_generation runtime_generation) = snapshot.runtime_generation in
  `Assoc
    [
      ("sessionId", `String session_id);
      ("workerId", `String worker_id);
      ("runtimeGeneration", `Int runtime_generation);
      ("workerPid", `Int snapshot.worker_pid);
      ( "harnessPid",
        match snapshot.harness_pid with Some pid -> `Int pid | None -> `Null );
      ("agentName", `String snapshot.agent_name);
      ("status", `String (worker_status_to_string snapshot.status));
      ("firstSequence", `Intlit (Int64.to_string snapshot.first_sequence));
      ("lastSequence", `Intlit (Int64.to_string snapshot.last_sequence));
      ( "lastFinishedAt",
        match snapshot.last_finished_at with
        | Some finished_at -> `Float finished_at
        | None -> `Null );
      ("retentionPruned", `Bool snapshot.retention_pruned);
    ]

let bounded_int field ~minimum value =
  if value < Int64.of_int minimum || value > Int64.of_int max_int then
    Error (Printf.sprintf "%s must be between %d and %d" field minimum max_int)
  else Ok (Int64.to_int value)

let snapshot_of_yojson json =
  let open Yojson.Safe.Util in
  let ( let* ) = Result.bind in
  let* session_id_string =
    string_of_json_exn "sessionId" (member "sessionId" json)
  in
  let* session_id = Session_id.of_string session_id_string in
  let* worker_id_string =
    string_of_json_exn "workerId" (member "workerId" json)
  in
  let* worker_id = Worker_id.of_string worker_id_string in
  let* runtime_generation =
    int64_of_json_exn "runtimeGeneration" (member "runtimeGeneration" json)
  in
  let* runtime_generation =
    bounded_int "runtimeGeneration" ~minimum:0 runtime_generation
  in
  let* worker_pid = int64_of_json_exn "workerPid" (member "workerPid" json) in
  let* worker_pid = bounded_int "workerPid" ~minimum:1 worker_pid in
  let* harness_pid =
    match member "harnessPid" json with
    | `Null -> Ok None
    | value ->
        let* pid = int64_of_json_exn "harnessPid" value in
        let* pid = bounded_int "harnessPid" ~minimum:1 pid in
        Ok (Some pid)
  in
  let* agent_name = string_of_json_exn "agentName" (member "agentName" json) in
  let* status_string = string_of_json_exn "status" (member "status" json) in
  let* status = worker_status_of_string status_string in
  let* first_sequence =
    int64_of_json_exn "firstSequence" (member "firstSequence" json)
  in
  let* last_sequence =
    int64_of_json_exn "lastSequence" (member "lastSequence" json)
  in
  let* last_finished_at =
    match member "lastFinishedAt" json with
    | `Null -> Ok None
    | value ->
        let* value = float_of_json_exn "lastFinishedAt" value in
        Ok (Some value)
  in
  let* retention_pruned =
    bool_of_json_exn "retentionPruned" (member "retentionPruned" json)
  in
  Ok
    {
      session_id;
      worker_id;
      runtime_generation = Runtime_generation runtime_generation;
      worker_pid;
      harness_pid;
      agent_name;
      status;
      first_sequence;
      last_sequence;
      last_finished_at;
      retention_pruned;
    }
