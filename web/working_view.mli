type phase = Running_tool | Thinking | Awaiting_permission | Connecting | Idle

type tool = {
  sequence : int64;
  title : string;
  detail : string;
  status : string;
}

type t = { phase : phase; current : tool option; recent : tool list }

val derive :
  snapshot:Runtime_domain.t option ->
  connecting:bool ->
  events:Event_history.event list ->
  entries:Event_history.entry list ->
  t

val phase_label : phase -> string
val phase_detail : t -> string
