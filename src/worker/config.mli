(* Worker CLI configuration.

   Parses the command-line arguments into the [args] record. The
   record fields are named so call sites read at the use site:

   { Worker.run ~env
       ~socket_path:args.socket_path
       ~database_path:args.database_path
       ~session_id:args.session_id
       ... }

   The dispatch and permission timeouts and the frame-size bound
   are wall-clock guards shared by the harness reader and the
   protocol handler; exposing them as named constants means every
   site that cares reads the same value. *)

type args = {
  socket_path : string;
  database_path : string;
  session_id : string;
  worker_id : string;
  generation : string;
  workspace : string;
  harness_command : string;
  harness_args : string list;
  session_mcp : string;
  broker_url : string;
  broker_token : string;
  curl_command : string;
}

(** Maximum bytes of a single harness frame (request or response).
    Frames larger than this are rejected so a misbehaving harness
    cannot exhaust the worker's memory. *)
val max_frame_bytes : int

(** Wall-clock budget for an open ACP command. When the harness
    stops producing session/prompt responses for this long the
    worker declares the command [Ambiguous] and surfaces a
    `command.dispatch_timeout` event. *)
val dispatch_timeout_seconds : float

(** Wall-clock budget for an unanswered permission request. When
    the user does not respond within this window the worker
    expires the permission and replies [cancelled] on the user's
    behalf. *)
val permission_timeout_seconds : float

(** A permission request the harness has sent and the user has not
    yet resolved. The worker carries one per pending request id
    so it can answer in the right order. *)
type pending_permission = {
  raw_id : Yojson.Safe.t;
  params : Yojson.Safe.t;
  requested_at : float;
}

val parse : unit -> args
