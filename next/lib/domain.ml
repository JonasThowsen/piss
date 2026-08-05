type session_id = Session_id of string
type worker_id = Worker_id of string
type runtime_generation = Runtime_generation of int

type command_state =
  | Received
  | Accepted
  | Dispatched
  | Acknowledged
  | Completed
  | Ambiguous
  | Rejected

type worker_status =
  | Starting
  | Idle
  | Running
  | Requires_action
  | Stopped
  | Failed

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
  status : worker_status;
  last_sequence : int64;
}

let command_state_to_string = function
  | Received -> "received"
  | Accepted -> "accepted"
  | Dispatched -> "dispatched"
  | Acknowledged -> "acknowledged"
  | Completed -> "completed"
  | Ambiguous -> "ambiguous"
  | Rejected -> "rejected"

let command_state_of_string = function
  | "received" -> Ok Received
  | "accepted" -> Ok Accepted
  | "dispatched" -> Ok Dispatched
  | "acknowledged" -> Ok Acknowledged
  | "completed" -> Ok Completed
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

let event_to_yojson event =
  `Assoc
    [
      ("sequence", `Intlit (Int64.to_string event.sequence));
      ("kind", `String event.kind);
      ("payload", event.payload);
      ("createdAt", `Float event.created_at);
    ]

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
      ("status", `String (worker_status_to_string snapshot.status));
      ("lastSequence", `Intlit (Int64.to_string snapshot.last_sequence));
    ]
