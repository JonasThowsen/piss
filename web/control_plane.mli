module Session : sig
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

  val harness_to_string : harness -> string
  val status_to_string : status -> string
end

val decode_sessions : string -> (Session.t list, string) result
