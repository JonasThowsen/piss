type command_state = Timeline_projection.command_state =
  | Received
  | Accepted
  | Dispatched
  | Acknowledged
  | Completed
  | Cancelled
  | Ambiguous
  | Rejected

type permission_option = Timeline_projection.permission_option = {
  option_id : string;
  name : string;
  kind : string;
}

type permission_tool = Timeline_projection.permission_tool = {
  tool_call_id : string;
  title : string;
  kind : string;
  status : string;
  raw_input : Yojson.Safe.t option;
}

type permission_request = Timeline_projection.permission_request = {
  request_id : string;
  session_id : string;
  tool : permission_tool;
  options : permission_option list;
}

type pending_permission = { sequence : int64; request : permission_request }

type entry = Timeline_projection.entry =
  | User of { sequence : int64; command_id : string; text : string }
  | Agent of { sequence : int64; message_id : string; text : string }
  | Tool of {
      sequence : int64;
      tool_call_id : string;
      title : string;
      input : string;
      output : string;
      status : string;
      artifacts : string list;
    }
  | Command_state of {
      sequence : int64;
      command_id : string;
      state : command_state;
    }
  | Permission_requested of { sequence : int64; request : permission_request }
  | Permission_resolved of {
      sequence : int64;
      request_id : string;
      option_id : string option;
    }
  | Permission_cancelled of { sequence : int64; request_id : string }

type event

val decode : string -> (entry list, string) result
val decode_events : string -> (event list, string) result
val decode_event : string -> (event, string) result
val project : event list -> entry list
val sequence : event -> int64
val kind : event -> string
val outbox_update : event -> Outbox_projection.update option
val refreshes_session : event -> bool
val command_state_to_string : command_state -> string
val command_is_terminal : command_id:string -> entry list -> bool
val pending_permissions : entry list -> pending_permission list
