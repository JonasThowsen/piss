(* Pure domain types for the PISS control plane and worker. These values define
   the wire contract projected to the separately compiled browser application;
   this module must not perform IO.

   Types are concrete where the caller needs to pattern-match (event, snapshot,
   command_state, worker_status). They are abstract by wrapping in a
   single-variant record where the caller only needs equality and JSON encoding,
   and where representing the value as a different shape in the future would be
   a breaking change worth calling attention to (session_id, worker_id,
   runtime_generation).

   Naming follows the Real World OCaml "Design with Modules" conventions: this
   module is named `Domain`, the primary types are `t`, the JSON encoders are
   named `*_to_yojson` and `*_of_yojson`, and every value takes the abstract
   identity first when it appears in a signature. *)

type session_id
(** A PISS-owned session identity, allocated by the control plane and durable
    for the lifetime of the registry. The wrapping record signals that callers
    should never reach inside. *)

type worker_id
(** A worker incarnation. One worker process owns zero or one session at a time;
    a session may be moved across workers when the active worker upgrades. *)

type runtime_generation
(** A monotonically increasing writable runtime generation, owned by the control
    plane. Every command that targets a worker binds to a runtime generation so
    stale generations fail closed. *)

(** Lifecycle state of a single command issued by the browser and accepted by
    the worker. Transitions are:

    received -> accepted -> dispatched -> acknowledged -> completed \\->
    ambiguous received -> rejected

    The worker persists `accepted` before writing to the harness. A duplicate
    command returns the existing state and is never redispatched. A worker crash
    between dispatch and acknowledgement reconciles to `ambiguous` instead of
    silently retrying. *)
type command_state =
  | Received
  | Accepted
  | Dispatched
  | Acknowledged
  | Completed
  | Cancelled
  | Ambiguous
  | Rejected

(** Lifecycle state of a single worker process. The control plane projects this
    into a session-attention state for the browser. *)
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
(** A user-supplied image attachment. MIME type, base64 data, and size are
    validated at the wire boundary by [Wire.images_member]. *)

type resource_input = { path : string }
(** A workspace-relative path naming a file the harness may read. Validity
    (workspace-relative, no traversal, bounded length) is enforced by
    [Piss_shared.Workspace_files.valid_relative_path] at every wire boundary. *)

type event = {
  sequence : int64;
  kind : string;
  payload : Yojson.Safe.t;
  created_at : float;
}
(** One durable row in the worker event ledger. The sequence is allocated by the
    worker, the kind is the discriminator, and payload is the structured
    envelope specific to that kind. *)

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
(** The state the control plane reads from a worker at connection time.
    `first_sequence` and `last_sequence` describe the worker's bounded event
    spool; `retention_pruned` signals whether the spool has been compacted at
    least once since startup. *)

val session_id : string -> session_id
val worker_id : string -> worker_id
val runtime_generation : int -> runtime_generation
val session_id_to_string : session_id -> string
val worker_id_to_string : worker_id -> string
val runtime_generation_to_int : runtime_generation -> int
val command_state_to_string : command_state -> string
val command_state_of_string : string -> (command_state, string) result
val worker_status_to_string : worker_status -> string
val worker_status_of_string : string -> (worker_status, string) result
val event_to_yojson : event -> Yojson.Safe.t
val event_of_yojson : Yojson.Safe.t -> (event, string) result
val snapshot_to_yojson : snapshot -> Yojson.Safe.t
val snapshot_of_yojson : Yojson.Safe.t -> (snapshot, string) result
