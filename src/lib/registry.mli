(* Durable SQLite-backed registry of workspaces, sessions, peer
   requests, and peer subscriptions. The control plane holds one
   [t] open for its lifetime; every function takes it as the first
   argument.

   The schema is migrated inside [open_] from any pre-existing
   database file; callers do not see migrations. After [open_]
   returns the database is at the current schema and is safe for
   concurrent use from any number of fibers.

   Every identifier in this module is a plain string at the SQL
   layer; the wrapper types in [Piss_shared.Domain] are not used
   here because the registry is a backend-only database, not part
   of the shared API. *)

exception Registry_error of string

(** A handle to an open registry database. *)
type t

(** A durable allowlisted workspace root. *)
type workspace = {
  id : string;
  name : string;
  root : string;
  created_at : float;
}

(** A durable PISS-owned session. The token is opaque and is the
    shared secret the worker carries to authenticate with the
    control plane over the broker. *)
type session = {
  id : string;
  title : string;
  harness : string;
  created_at : float;
  archived_at : float option;
  broker_token : string;
  workspace_id : string;
}

(** A durable inter-session request: the source session asked the
    target session a question, and the worker is responsible for
    dispatching and collecting the response. *)
type peer_request = {
  id : string;
  source_id : string;
  target_id : string;
  prompt : string;
  command_id : string;
  start_sequence : int64;
  state : string;
  response : string option;
}

(** A durable subscription: the source session is waiting for one
    or more peer requests to finish (either any one, or all of them)
    before the control plane wakes it with a fresh turn. *)
type peer_subscription = {
  id : string;
  source_id : string;
  request_ids : string list;
  wait_for : string;
  command_id : string;
  state : string;
}

(** Open or create the registry at [path]. Migrates any pre-existing
    schema forward; returns a registry whose [close] must be called
    before the process exits. *)
val open_ : path:string -> t

(** Close the registry. Idempotent: closing twice is a no-op. *)
val close : t -> unit

(** Run [f] inside a SQLite transaction. Rolls back on any
    exception raised by [f]; commits on normal return. *)
val transaction : t -> (unit -> 'a) -> 'a

(** Persist a workspace. If the [id] already exists, update [name]
    and [root]; otherwise insert. *)
val upsert_workspace : t -> id:string -> name:string -> root:string -> unit

(** Same as [upsert_workspace] but additionally stores the
    declarative configuration flag in the metadata. Used at
    service-startup to seed the registry. *)
val configure_workspace : t -> id:string -> name:string -> root:string -> unit

(** Look up a workspace by its root path. Returns [None] when no
    registered workspace matches. *)
val find_workspace_by_root : t -> string -> workspace option

(** Every registered workspace, in deterministic order. *)
val list_workspaces : t -> workspace list

(** Look up a workspace by its id. *)
val find_workspace : t -> string -> workspace option

(** Number of sessions (active or archived) bound to a workspace. *)
val workspace_session_count : t -> string -> int

(** Remove a workspace by id. Returns [false] if the id does not
    exist; the caller is responsible for ensuring no sessions are
    bound to the workspace before calling. *)
val remove_workspace : t -> string -> bool

(** Assign every session that has no workspace yet to [workspace_id].
    Used at service startup to migrate a stale database. *)
val assign_unscoped_sessions : t -> string -> unit

(** Insert a session row. [id] must be unique. Returns the
    freshly-created [session] so the caller can capture the
    [broker_token] without a follow-up [find] call. *)
val insert :
  t ->
  id:string ->
  title:string ->
  harness:string ->
  workspace_id:string ->
  session

(** [include_archived:true] returns every session (active and
    archived); [include_archived:false] returns only sessions with
    [archived_at = None]. *)
val list : t -> include_archived:bool -> session list

(** Look up a session by id, active or archived. *)
val find : t -> string -> session option

(** Look up an active (not archived) session by id. *)
val find_active : t -> string -> session option

(** Look up an active session by the broker token it carries. *)
val find_active_by_token : t -> string -> session option

(** Number of active sessions. *)
val active_count : t -> int

(** Look up a peer request by id. *)
val find_peer_request : t -> string -> peer_request option

(** Accept a new peer request. If [id] already exists with the
    same source, target, and prompt, the existing row is returned
    (with [duplicate] returned as [true] via the second tuple
    component). Otherwise a fresh row is inserted. *)
val accept_peer_request :
  t ->
  id:string ->
  source_id:string ->
  target_id:string ->
  prompt:string ->
  command_id:string ->
  start_sequence:int64 ->
  peer_request * bool

(** List every peer request whose source is [source_id]. *)
val list_peer_requests : t -> source_id:string -> peer_request list

(** Look up a peer subscription by id. *)
val find_peer_subscription : t -> string -> peer_subscription option

(** Accept a new peer subscription. Idempotent on [id] with the
    same (source_id, request_ids, wait_for) triple. *)
val accept_peer_subscription :
  t ->
  id:string ->
  source_id:string ->
  request_ids:string list ->
  wait_for:string ->
  command_id:string ->
  peer_subscription * bool

(** Every peer subscription that has not yet fired its wake command. *)
val list_open_peer_subscriptions : t -> peer_subscription list

(** Mark a subscription as having dispatched its wake command. *)
val mark_peer_subscription_dispatching : t -> string -> unit

(** Mark a subscription as completed (after the wake turn finishes).
    Returns [false] if the subscription was already delivered. *)
val complete_peer_subscription : t -> string -> bool

(** Mark a peer request as having been dispatched to its target. *)
val mark_peer_dispatching : t -> string -> start_sequence:int64 -> unit

(** Update the state of a peer request. *)
val update_peer_request :
  t -> string -> state:string -> response:string option -> unit

(** Mark a peer request as completed and store [response]. Returns
    [false] if the request has already completed. *)
val complete_peer_request : t -> string -> string -> bool

(** Rename a session by id. Returns [false] if the id does not
    exist. *)
val rename_session : t -> string -> string -> bool

(** Archive a session by id. Returns [false] if the session does
    not exist or is already archived. *)
val archive : t -> string -> bool

(** Restore an archived session by id. Returns [false] if the
    session does not exist or is not archived. *)
val restore : t -> string -> bool

(** Every archived session. *)
val list_archived : t -> session list

val workspace_to_yojson : workspace -> Yojson.Safe.t
val session_to_yojson : session -> Yojson.Safe.t
