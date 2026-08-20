(* Mutable runtime state for one session worker. *)

type t
(** The protocol state is abstract so command, permission, configuration,
    session, and upgrade transitions cannot be partially updated by callers. *)

val make :
  args:Config.args ->
  store:Piss_core.Store.t ->
  workspace:string ->
  harness_pid:int ->
  runtime_worker_id:string ->
  runtime_generation:int ->
  send:(Yojson.Safe.t -> unit) ->
  require_rpc_result:
    (id:string -> Yojson.Safe.t -> Yojson.Safe.t * Yojson.Safe.t) ->
  t
(** Construct the bootstrap state. Agent capabilities and the ACP session id are
    installed after the initialize handshake completes. *)

val args : t -> Config.args
val store : t -> Piss_core.Store.t

val append_event :
  t -> kind:string -> payload:Yojson.Safe.t -> Piss_core.Domain.event
(** Append and wake every blocked live-event observer. *)

val wait_events :
  t ->
  clock:_ Eio.Time.clock ->
  after:int64 ->
  limit:int ->
  timeout_ms:int ->
  Piss_core.Domain.event list
(** Block without polling until events exist after [after], or until timeout. *)

val workspace : t -> string
val runtime_worker_id : t -> string
val runtime_target : t -> Piss_core.Domain.runtime_target

val initialize_agent :
  t -> name:string -> supports_load:bool -> supports_images:bool -> unit
(** Complete the ACP initialize transition with the negotiated agent data. *)

val supports_images : t -> bool
val status : t -> Piss_core.Domain.worker_status
val set_status : t -> Piss_core.Domain.worker_status -> unit
val set_harness_running : t -> bool -> unit
val refresh_status : t -> unit
val harness_running : t -> bool
val runtime_busy : t -> bool
val snapshot : t -> Piss_core.Domain.snapshot
val harness_session_id : t -> string
val set_harness_session_id : t -> string -> unit
val create_harness_session : t -> string
val record_additional_session : t -> session_id:string -> unit
val additional_session_limit_reached : t -> bool
val config_options : t -> Yojson.Safe.t
val set_config_options : t -> Yojson.Safe.t -> unit
val current_config_value : t -> config_id:string -> string option

val change_config_option :
  t ->
  id:string ->
  config_id:string ->
  value:string ->
  Yojson.Safe.t * Yojson.Safe.t
(** Run one configuration RPC while tracking the configuration-change depth,
    then install and persist any options returned by the agent. *)

val record_dispatched : t -> command_id:string -> unit
val record_dispatch_failed : t -> command_id:string -> unit

val record_completed :
  t -> command_id:string -> state:Piss_core.Domain.command_state -> unit

val is_running_command : t -> command_id:string -> bool
val running_command_count : t -> int
val pending_permission_count : t -> int
val configuration_change_depth : t -> int

val record_pending_permission :
  t -> request_id:string -> raw_id:Yojson.Safe.t -> params:Yojson.Safe.t -> unit

val pending_permission :
  t -> request_id:string -> Config.pending_permission option

val resolve_permission : t -> request_id:string -> unit
val cancel_permission : t -> request_id:string -> bool
val expire_stuck_permissions : t -> now:float -> unit

val send : t -> Yojson.Safe.t -> unit
(** Send a protocol payload to the ACP harness. *)

val start_upgrade :
  t -> target:string -> deadline:float -> Piss_core.Domain.event

val upgrade_is_preparing : t -> bool
