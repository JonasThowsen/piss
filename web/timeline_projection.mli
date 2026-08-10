type command_state =
  | Received
  | Accepted
  | Dispatched
  | Acknowledged
  | Completed
  | Cancelled
  | Ambiguous
  | Rejected

type permission_option = { option_id : string; name : string; kind : string }

type permission_tool = {
  tool_call_id : string;
  title : string;
  kind : string;
  status : string;
  raw_input : Yojson.Safe.t option;
}

type permission_request = {
  request_id : string;
  session_id : string;
  tool : permission_tool;
  options : permission_option list;
}

type artifact = Acp_content.artifact

type update =
  | User_update of { sequence : int64; command_id : string; text : string }
  | Agent_chunk of { sequence : int64; message_id : string; text : string }
  | Tool_call of {
      sequence : int64;
      tool_call_id : string;
      title : string;
      input : string;
      status : string;
      artifacts : artifact list;
    }
  | Tool_call_update of {
      sequence : int64;
      tool_call_id : string;
      title : string option;
      input : string option;
      output : string option;
      status : string option;
      artifacts : artifact list;
    }
  | Command_state_update of {
      sequence : int64;
      command_id : string;
      state : command_state;
    }
  | Permission_requested_update of {
      sequence : int64;
      request : permission_request;
    }
  | Permission_resolved_update of {
      sequence : int64;
      request_id : string;
      option_id : string option;
    }
  | Permission_cancelled_update of { sequence : int64; request_id : string }

type entry =
  | User of { sequence : int64; command_id : string; text : string }
  | Agent of { sequence : int64; message_id : string; text : string }
  | Tool of {
      sequence : int64;
      tool_call_id : string;
      title : string;
      input : string;
      output : string;
      status : string;
      artifacts : artifact list;
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

type timeline_block =
  | Message_entry of entry
  | Activity_group of { key : string; sequence : int64; entries : entry list }

val project : update list -> entry list
val group_timeline : entry list -> timeline_block list

val tool_text :
  input:string -> output:string -> artifacts:artifact list -> string
