(* Pure domain types for the PISS control plane, worker, and browser shell. See
   [domain.mli] for the design notes. *)

type session_id = Session_id of string
type worker_id = Worker_id of string
type runtime_generation = Runtime_generation of int

let session_id s = Session_id s
let worker_id s = Worker_id s
let runtime_generation i = Runtime_generation i
let session_id_to_string (Session_id s) = s
let worker_id_to_string (Worker_id s) = s
let runtime_generation_to_int (Runtime_generation i) = i

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

let worker_status_to_string = function
  | Starting -> "starting"
  | Idle -> "idle"
  | Running -> "running"
  | Requires_action -> "requires_action"
  | Stopped -> "stopped"
  | Failed -> "failed"

let worker_status_of_string = function
  | "starting" -> Ok Starting
  | "idle" -> Ok Idle
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
      ("retentionPruned", `Bool snapshot.retention_pruned);
    ]

let snapshot_of_yojson json =
  let open Yojson.Safe.Util in
  let bind a b = Result.bind a b in
  let map f a = Result.map f a in
  bind
    (string_of_json_exn "sessionId" (member "sessionId" json))
    (fun session_id_str ->
      bind
        (string_of_json_exn "workerId" (member "workerId" json))
        (fun worker_id_str ->
          bind
            (int64_of_json_exn "runtimeGeneration"
               (member "runtimeGeneration" json)
            |> map Int64.to_int)
            (fun runtime_generation_int ->
              bind
                (int64_of_json_exn "workerPid" (member "workerPid" json)
                |> map Int64.to_int)
                (fun worker_pid ->
                  bind
                    (match member "harnessPid" json with
                    | `Null -> Ok None
                    | value ->
                        int64_of_json_exn "harnessPid" value
                        |> map Int64.to_int |> map Option.some)
                    (fun harness_pid ->
                      bind
                        (string_of_json_exn "agentName"
                           (member "agentName" json))
                        (fun agent_name ->
                          bind
                            (string_of_json_exn "status" (member "status" json))
                            (fun status_str ->
                              bind (worker_status_of_string status_str)
                                (fun status ->
                                  bind
                                    (int64_of_json_exn "firstSequence"
                                       (member "firstSequence" json))
                                    (fun first_sequence ->
                                      bind
                                        (int64_of_json_exn "lastSequence"
                                           (member "lastSequence" json))
                                        (fun last_sequence ->
                                          bind
                                            (bool_of_json_exn "retentionPruned"
                                               (member "retentionPruned" json))
                                            (fun retention_pruned ->
                                              Ok
                                                {
                                                  session_id =
                                                    Session_id session_id_str;
                                                  worker_id =
                                                    Worker_id worker_id_str;
                                                  runtime_generation =
                                                    Runtime_generation
                                                      runtime_generation_int;
                                                  worker_pid;
                                                  harness_pid;
                                                  agent_name;
                                                  status;
                                                  first_sequence;
                                                  last_sequence;
                                                  retention_pruned;
                                                })))))))))))
