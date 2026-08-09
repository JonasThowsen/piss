type command_state =
  | Received
  | Accepted
  | Dispatched
  | Acknowledged
  | Completed
  | Cancelled
  | Ambiguous
  | Rejected

type entry =
  | User of { sequence : int64; command_id : string; text : string }
  | Agent of { sequence : int64; message_id : string; text : string }
  | Tool of {
      sequence : int64;
      tool_call_id : string;
      title : string;
      detail : string;
      status : string;
    }
  | Command_state of {
      sequence : int64;
      command_id : string;
      state : command_state;
    }

val decode : string -> (entry list, string) result
val command_state_to_string : command_state -> string
val command_is_terminal : command_id:string -> entry list -> bool
