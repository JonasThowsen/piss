(* Worker CLI configuration.

   Parses the command-line arguments into the [args] record. The record fields
   are named so call sites read at the use site:

   { Worker.run ~env ~socket_path:args.socket_path
   ~database_path:args.database_path ~session_id:args.session_id ... }

   The permission timeout and frame-size bound are wall-clock guards shared by
   the harness reader and protocol handler; exposing them as named constants
   means every site that cares reads the same value. *)

type args = {
  socket_path : string;
  database_path : string;
  session_id : Piss_shared.Domain.Session_id.t;
  worker_id : Piss_shared.Domain.Worker_id.t;
  generation : string;
  workspace : string;
  harness_command : string;
  harness_args : string list;
  session_mcp : string;
  broker_url : string;
  broker_token : string;
  curl_command : string;
}

val max_frame_bytes : int
(** Maximum bytes of a single harness frame (request or response). Frames larger
    than this are rejected so a misbehaving harness cannot exhaust the worker's
    memory. *)

val max_event_page_bytes : int
(** Target encoded size for event-history pages. Large pages retain the edge
    needed for cursor-based pagination rather than exceeding the wire frame. *)

val permission_timeout_seconds : float
(** Wall-clock budget for an unanswered permission request. When the user does
    not respond within this window the worker expires the permission and replies
    [cancelled] on the user's behalf. *)

type pending_permission = {
  raw_id : Yojson.Safe.t;
  params : Yojson.Safe.t;
  requested_at : float;
}
(** A permission request the harness has sent and the user has not yet resolved.
    The worker carries one per pending request id so it can answer in the right
    order. *)

val parse : unit -> args
