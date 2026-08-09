(* Durable SQLite-backed ledger for a single session worker. One
   [t] is opened per worker process; every function takes it as
   the first argument.

   The ledger has three concerns:

   * the bounded event spool (a monotonic sequence plus
     structured payloads, with retention applied on overflow);
   * the command ledger (durable command ids, accepted-state
     transitions, image and resource metadata);
   * key/value metadata used for upgrade bookkeeping and
     config-option persistence.

   The schema is migrated inside [open_] from any pre-existing
   database file. Callers do not see migrations. *)

exception Store_error of string

(** A handle to an open worker ledger. *)
type t

(** The state stored alongside each accepted command: the durable
    command state plus whether the just-completed accept was a
    duplicate. *)
type accepted_command = {
  state : Piss_shared.Domain.command_state;
  duplicate : bool;
}

(** The maximum number of event rows the worker will retain. When
    the spool reaches this bound, [append_event] runs
    [compact_events_if_needed] which removes the oldest ordinary
    rows while preserving rows whose kind is in [retained_event_kinds]
    (permission requests, acceptances, harness disconnects,
    reconciliation records). *)
val max_retained_events : int

(** A separate upper bound on retained command rows; commands
    beyond this are evicted when the table grows past the bound.
    Independent of [max_retained_events] so a flood of command
    accepts cannot push out event rows. *)
val max_retained_commands : int

(** Event kinds that the retention pass must never evict. *)
val retained_event_kinds : string list

(** The SQL predicate used by the retention pass to skip the rows
    above. Test-only export; the control plane does not depend on
    the predicate shape. *)
val retention_predicate : string list -> string

(** Open or create the ledger at [path]. Migrates any pre-existing
    schema forward. *)
val open_ :
  path:string ->
  session_id:Piss_shared.Domain.session_id ->
  worker_id:Piss_shared.Domain.worker_id ->
  t

(** Close the ledger. Idempotent: closing twice is a no-op. *)
val close : t -> unit

(** Run [f] inside a SQLite transaction. *)
val transaction : t -> (unit -> 'a) -> 'a

(** The highest event sequence ever appended, or 0L for a fresh
    database. *)
val last_sequence : t -> int64

(** The lowest event sequence currently retained. Advances past
    the compact pass; the browser can use this to know whether
    pre-startup events were evicted. *)
val first_retained_sequence : t -> int64

(** Read a metadata key. Returns [None] when the key is absent. *)
val get_metadata : t -> string -> string option

(** Write a metadata key. Overwrites any existing value. *)
val set_metadata : t -> string -> string -> unit

(** Append a single event row. Runs the retention pass when the
    spool reaches [max_retained_events] entries; the row is
    always visible to subsequent reads regardless of retention. *)
val append_event :
  t -> kind:string -> payload:Yojson.Safe.t -> Piss_shared.Domain.event

(** Read events after [after] (exclusive), at most [limit] rows,
    in sequence order. *)
val list_events : t -> after:int64 -> limit:int -> Piss_shared.Domain.event list

(** Read the [limit] events ending just before [before] (exclusive),
    in descending-then-reversed sequence order. *)
val list_events_before :
  t -> before:int64 -> limit:int -> Piss_shared.Domain.event list

(** Read the [limit] most recent events in sequence order. *)
val list_recent_events :
  t -> limit:int -> Piss_shared.Domain.event list

(** Look up the current durable state of a command id, or [None]
    if the command is unknown. *)
val find_command : t -> string -> Piss_shared.Domain.command_state option

(** Accept a command. If [command_id] already exists in the ledger,
    the existing state is returned and [duplicate] is [true];
    otherwise a fresh row is inserted with state [Accepted] and
    [duplicate] is [false]. *)
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

(** Read and clear the deferred prompt content (text, images,
    resources) for a command, stored as a Yojson text column.
    Returns [None] when no content has been recorded (e.g. the
    command was never written, or [clear_command_content] already
    scrubbed it). *)
val command_content : t -> string -> string option

(** Drop the stored prompt body for a command. Called after a
    successful dispatch so the body is not kept indefinitely. *)
val clear_command_content : t -> command_id:string -> unit

(** Force the durable state of a command. Used when the harness
    has acknowledged the dispatch. Does not check the previous
    state. *)
val set_command_state :
  t -> command_id:string -> Piss_shared.Domain.command_state -> unit

(** Set the command state only if the command is currently in a
    non-terminal state. Returns [true] when the update was applied,
    [false] when the command is already terminal (so callers do
    not accidentally overwrite a completed state). *)
val try_set_command_state_if_open :
  t -> command_id:string -> Piss_shared.Domain.command_state -> bool

(** Every command id whose durable state is not terminal
    (completed/cancelled/rejected/ambiguous). Used by the worker
    startup reconciliation pass to mark dispatched-but-not-
    acknowledged commands as ambiguous. *)
val incomplete_command_ids : t -> string list

(** Every command currently in the [Dispatched] state, paired
    with the dispatch timestamp. Used by the control plane to
    recover the harness dispatch state when a worker reconnects
    after a crash; the timestamp lets the recovery loop detect
    commands that have been dispatched for too long. *)
val dispatched_commands : t -> (string * float) list

(** On worker startup, mark every command in [Dispatched] as
    [Ambiguous] (the harness never acknowledged the dispatch). The
    worker logs each transition so the operator can see which
    commands did not complete. Returns the list of reconciled ids. *)
val reconcile_incomplete_commands : t -> string list
