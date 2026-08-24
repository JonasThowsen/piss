type state =
  | Queued
  | Running
  | Complete
  | Failed
  | Paused
  | Stopped
  | Rejected

type kind = Subagent | Workflow | Step

type activity = {
  state : string option;
  current_tool : string option;
  turn_count : int option;
  tool_count : int option;
}

type node = {
  id : string;
  kind : kind;
  label : string;
  state : state;
  activity : activity option;
  children : node list;
}

type t = {
  generated_at : int64;
  omitted_runs : int;
  omitted_children : int;
  runs : node list;
}

val decode : path:string -> Yojson.Safe.t -> (t, string) result
val state_to_string : state -> string
val kind_to_string : kind -> string
val is_running : state -> bool
