type history_action =
  | Start of string
  | Initial of string * Event_history.event list
  | Append of string * Event_history.event
  | Begin_older of string
  | Prepend_older of string * Event_history.event list
  | Older_failed of string * string
  | History_failed of string * string

type deciding_action = Add of string | Remove of string | Reset

type runtime_state = {
  session_id : string option;
  snapshot : Runtime_domain.t option;
  loading : bool;
  error : string option;
}

type shell_model = { runtime : runtime_state; tab : Session_tabs.t }

type shell_action =
  | Runtime_start of string
  | Runtime_loaded of string * Runtime_domain.t
  | Runtime_failed of string * string
  | Select_tab of Session_tabs.t

val live_event_capacity : int
val empty_runtime : runtime_state
val apply_shell : 'a -> shell_model -> shell_action -> shell_model

val apply_history :
  'a -> Timeline_view.state -> history_action -> Timeline_view.state

val apply_deciding :
  'a -> Core.String.Set.t -> deciding_action -> Core.String.Set.t
