(* Durable SQLite-backed ledger for a single session worker. One [t] is opened
   per worker process; every function takes it as the first argument.

   The ledger has three concerns:

   * the bounded event spool (a monotonic sequence plus structured payloads,
   with retention applied on overflow); * the command ledger (durable command
   ids, accepted-state transitions, image and resource metadata); * key/value
   metadata used for upgrade bookkeeping and config-option persistence.

   The schema is migrated inside [open_] from any pre-existing database file.
   Callers do not see migrations. *)

exception Store_error of string

type t
(** A handle to an open worker ledger. *)

type accepted_command = {
  state : Piss_shared.Domain.command_state;
  duplicate : bool;
}

type recovered_command = {
  state : Piss_shared.Domain.command_state;
  duplicate : bool;
  prompt : string;
}

type runtime_identity = { worker_id : string; runtime_generation : int }
(** The newly claimed worker incarnation and durable fencing generation. *)

(** The state stored alongside each accepted command: the durable command state
    plus whether the just-completed accept was a duplicate. *)

val max_retained_events : int
(** The maximum number of event rows the worker will retain. When the spool
    reaches this bound, [append_event] runs [compact_events_if_needed] which
    removes the oldest ordinary rows while preserving rows whose kind is in
    [retained_event_kinds] (permission requests, acceptances, harness
    disconnects, reconciliation records). *)

val max_retained_commands : int
(** A separate upper bound on retained command rows; commands beyond this are
    evicted when the table grows past the bound. Independent of
    [max_retained_events] so a flood of command accepts cannot push out event
    rows. *)

val retained_event_kinds : string list
(** Event kinds that the retention pass must never evict. *)

val retention_predicate : string list -> string
(** The SQL predicate used by the retention pass to skip the rows above.
    Test-only export; the control plane does not depend on the predicate shape.
*)

val open_ :
  path:string ->
  session_id:Piss_shared.Domain.session_id ->
  worker_id:Piss_shared.Domain.worker_id ->
  t
(** Open or create the ledger at [path]. Migrates any pre-existing schema
    forward. *)

val close : t -> unit
(** Close the ledger. Idempotent: closing twice is a no-op. *)

val transaction : t -> (unit -> 'a) -> 'a
(** Run [f] inside a SQLite transaction. *)

val last_sequence : t -> int64
(** The highest event sequence ever appended, or 0L for a fresh database. *)

val first_retained_sequence : t -> int64
(** The lowest event sequence currently retained. Advances past the compact
    pass; the browser can use this to know whether pre-startup events were
    evicted. *)

val last_finished_at : t -> float option
(** The timestamp when the newest command finished, or [None] when the newest
    command is absent or non-terminal. *)

val get_metadata : t -> string -> string option
(** Read a metadata key. Returns [None] when the key is absent. *)

val set_metadata : t -> string -> string -> unit
(** Write a metadata key. Overwrites any existing value. *)

val claim_runtime : t -> runtime_identity
(** Atomically increment and persist the writable generation and derive a new
    worker-incarnation identity. Fails if the database belongs to another
    durable session. *)

val validate_runtime_target :
  t -> Piss_shared.Domain.runtime_target -> (unit, string) result
(** Compare a supplied target against both this process's claimed identity and
    the current durable fencing identity. *)

val append_event :
  t -> kind:string -> payload:Yojson.Safe.t -> Piss_shared.Domain.event
(** Append a single event row. Runs the retention pass when the spool reaches
    [max_retained_events] entries; the row is always visible to subsequent reads
    regardless of retention. *)

val list_events :
  ?max_bytes:int ->
  t ->
  after:int64 ->
  limit:int ->
  Piss_shared.Domain.event list
(** Read events after [after] (exclusive), at most [limit] rows, in sequence
    order. When [max_bytes] is set, stop before the encoded JSON page exceeds
    that target, retaining the earliest edge and at least one event. *)

val list_events_before :
  ?max_bytes:int ->
  t ->
  before:int64 ->
  limit:int ->
  Piss_shared.Domain.event list
(** Read events ending just before [before] (exclusive), in sequence order. When
    [max_bytes] is set, retain the latest edge and at least one event. *)

val list_recent_events :
  ?max_bytes:int -> t -> limit:int -> Piss_shared.Domain.event list
(** Read the most recent events in sequence order. When [max_bytes] is set,
    retain the latest edge and at least one event. *)

val find_command : t -> string -> Piss_shared.Domain.command_state option
(** Look up the current durable state of a command id, or [None] if the command
    is unknown. *)

val accept_command :
  ?action:string ->
  ?content:Yojson.Safe.t ->
  ?images:Yojson.Safe.t list ->
  ?resources:Yojson.Safe.t list ->
  t ->
  command_id:string ->
  request_id:string ->
  prompt:string ->
  accepted_command
(** Accept a command. If [command_id] already exists in the ledger, the existing
    state is returned and [duplicate] is [true]; otherwise a fresh row is
    inserted with state [Accepted] and [duplicate] is [false]. *)

val accept_targeted_command :
  ?action:string ->
  ?content:Yojson.Safe.t ->
  ?images:Yojson.Safe.t list ->
  ?resources:Yojson.Safe.t list ->
  t ->
  target:Piss_shared.Domain.runtime_target ->
  command_id:string ->
  request_id:string ->
  prompt:string ->
  (accepted_command, string) result
(** Validate the runtime target and durably accept or deduplicate the command in
    one SQLite transaction. *)

val recover_targeted_text_command :
  ?discard_cleared_attachments:bool ->
  t ->
  target:Piss_shared.Domain.runtime_target ->
  command_id:string ->
  action:string ->
  (recovered_command, string) result
(** Explicitly reset an ambiguous command for same-ID text redispatch. Commands
    with images or resources fail closed unless [discard_cleared_attachments] is
    set, because their cleared payload cannot be reconstructed after the
    original dispatch. *)

val command_content : t -> string -> string option
(** Read and clear the deferred prompt content (text, images, resources) for a
    command, stored as a Yojson text column. Returns [None] when no content has
    been recorded (e.g. the command was never written, or
    [clear_command_content] already scrubbed it). *)

val clear_command_content : t -> command_id:string -> unit
(** Drop the stored prompt body for a command. Called after a successful
    dispatch so the body is not kept indefinitely. *)

val set_command_state :
  t -> command_id:string -> Piss_shared.Domain.command_state -> unit
(** Force the durable state of a command. Used when the harness has acknowledged
    the dispatch. Does not check the previous state. *)

val try_set_command_state_if_open :
  t -> command_id:string -> Piss_shared.Domain.command_state -> bool
(** Set the command state only if the command is currently in a non-terminal
    state. Returns [true] when the update was applied, [false] when the command
    is already terminal (so callers do not accidentally overwrite a completed
    state). *)

val incomplete_command_ids : t -> string list
(** Every command id whose durable state is not terminal
    (completed/cancelled/rejected/ambiguous). Used by the worker startup
    reconciliation pass to mark dispatched-but-not- acknowledged commands as
    ambiguous. *)

val dispatched_commands : t -> (string * float) list
(** Every command currently in the [Dispatched] state, paired with the dispatch
    timestamp. Used by the control plane to recover the harness dispatch state
    when a worker reconnects after a crash; the timestamp lets the recovery loop
    detect commands that have been dispatched for too long. *)

val reconcile_incomplete_commands : t -> string list
(** On worker startup, mark every command in [Dispatched] as [Ambiguous] (the
    harness never acknowledged the dispatch). The worker logs each transition so
    the operator can see which commands did not complete. Returns the list of
    reconciled ids. *)

val reconcile_ambiguous_responses : t -> string list
(** Repair ambiguous rows for which a durable terminal ACP response already
    exists, such as a response that arrived after the former dispatch timeout.
*)
