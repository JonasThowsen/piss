module Session : sig
  type harness = Pi | Opencode | Mock | Other of string

  type status = Runtime_domain.status =
    | Starting
    | Idle
    | Running
    | Requires_action
    | Stopped
    | Failed
    | Offline
    | Archived

  type runtime = Runtime_domain.t

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
