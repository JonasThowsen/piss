(* Pure method, path, and query parsing for the control-plane HTTP API. *)

type session_action = Archive of string | Restore of string | Rename of string

type event_page =
  | After of { cursor : int64; limit : int }
  | Before of { cursor : int64; limit : int }
  | Recent of { limit : int }

type route =
  | Get_broker_sessions
  | Get_broker_workspaces
  | Post_broker_workspaces
  | Post_broker_workspace_delete
  | Post_broker_sessions
  | Post_broker_finish
  | Post_broker_send
  | Post_broker_subscribe
  | Post_broker_ask
  | Post_broker_collect
  | Get_workspaces
  | Get_catalog_revision
  | Get_session_creation
  | Post_workspace_delete of string
  | Get_workspace_directories of { query : string }
  | Post_workspaces
  | Get_sessions of { archived : bool }
  | Get_session_audit of string
  | Post_sessions
  | Post_archived_sessions_delete
  | Post_session_action of session_action
  | Get_health
  | Get_session of { session_id : string option }
  | Get_file_mentions of { session_id : string option; query : string }
  | Get_config_options of { session_id : string option }
  | Post_config_options of { session_id : string option }
  | Get_event_stream of { session_id : string option; after : int64 }
  | Get_events of { session_id : string option; page : event_page }
  | Post_session_new
  | Post_commands of { session_id : string option }
  | Post_cancel of { session_id : string option }
  | Post_permissions of { session_id : string option }
  | Get_app_js
  | Get_asset of string
  | Method_not_allowed of { method_ : Cohttp.Code.meth; path : string }

val finishable_runtime_status : string -> bool
(** Only a positively observed idle worker is safe for creator-owned cleanup.
    Offline and failed snapshots deliberately fail closed. *)

val credential_authorized :
  path:string -> user_authorized:bool -> has_broker_session:bool -> bool
(** Broker credentials authorize only the dedicated broker namespace. *)

val parse :
  managed:bool ->
  method_:Cohttp.Code.meth ->
  uri:Uri.t ->
  last_event_id:string option ->
  (route, string) result
(** Parse a route without performing authorization, body IO, filesystem IO, or
    registry lookups. In fixed-worker mode managed-only GETs remain static asset
    candidates, preserving the existing fallback behavior. *)
