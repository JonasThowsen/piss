type status = Queued | Ambiguous

type item = {
  command_id : string;
  text : string;
  action : Prompt_command.action;
  status : status;
}

type update =
  | Accepted of {
      command_id : string;
      text : string;
      action : Prompt_command.action;
    }
  | State of { command_id : string; state : Timeline_projection.command_state }

val project : update list -> item list
val status_to_string : status -> string
