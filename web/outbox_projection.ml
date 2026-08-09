open! Core

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

type projection = { order : string list; items : item String.Map.t }

let project updates =
  let projected =
    List.fold updates ~init:{ order = []; items = String.Map.empty }
      ~f:(fun projected -> function
      | Accepted { action = Prompt_command.Prompt; _ } -> projected
      | Accepted { command_id; text; action } ->
          let order =
            if Map.mem projected.items command_id then projected.order
            else projected.order @ [ command_id ]
          in
          {
            order;
            items =
              Map.set projected.items ~key:command_id
                ~data:{ command_id; text; action; status = Queued };
          }
      | State { command_id; state = Ambiguous } ->
          {
            projected with
            items =
              Map.change projected.items command_id
                ~f:
                  (Option.map ~f:(fun item -> { item with status = Ambiguous }));
          }
      | State { command_id; state = Completed | Cancelled | Rejected } ->
          {
            order =
              List.filter projected.order ~f:(Fn.non (String.equal command_id));
            items = Map.remove projected.items command_id;
          }
      | State { state = Received | Accepted | Dispatched | Acknowledged; _ } ->
          projected)
  in
  List.filter_map projected.order ~f:(Map.find projected.items)

let status_to_string = function Queued -> "queued" | Ambiguous -> "ambiguous"
