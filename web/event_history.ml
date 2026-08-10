open! Core

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

type artifact = Timeline_projection.artifact

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

type pending_permission = { sequence : int64; request : permission_request }
type event = Event_decode.t

let command_state_to_string = function
  | Received -> "received"
  | Accepted -> "accepted"
  | Dispatched -> "dispatched"
  | Acknowledged -> "acknowledged"
  | Completed -> "completed"
  | Cancelled -> "cancelled"
  | Ambiguous -> "ambiguous"
  | Rejected -> "rejected"

let decode_events = Event_decode.decode_events
let decode_event = Event_decode.decode_event

let project events =
  events
  |> List.filter_map ~f:Event_decode.update
  |> Timeline_projection.project

let decode body = Result.map (decode_events body) ~f:project
let sequence = Event_decode.sequence
let kind = Event_decode.kind
let outbox_update = Event_decode.outbox_update

let refreshes_session event =
  let kind = Event_decode.kind event in
  String.equal kind "command.state"
  || String.is_prefix kind ~prefix:"acp.permission."
  || String.equal kind "acp.config_option.changed"
  || String.equal kind "worker.upgrade.completed"

let command_is_terminal ~command_id entries =
  List.exists entries ~f:(function
    | Command_state { command_id = candidate; state; _ }
      when String.equal command_id candidate -> (
        match state with
        | Completed | Cancelled | Ambiguous | Rejected -> true
        | Received | Accepted | Dispatched | Acknowledged -> false)
    | _ -> false)

let pending_permissions entries =
  let requests = Hashtbl.create (module String) in
  List.iter entries ~f:(function
    | Permission_requested { sequence; request } ->
        Hashtbl.set requests ~key:request.request_id ~data:{ sequence; request }
    | Permission_resolved { request_id; _ }
    | Permission_cancelled { request_id; _ } ->
        Hashtbl.remove requests request_id
    | User _ | Agent _ | Tool _ | Command_state _ -> ());
  Hashtbl.data requests
  |> List.sort
       ~compare:(fun (left : pending_permission) (right : pending_permission) ->
         Int64.compare left.sequence right.sequence)
