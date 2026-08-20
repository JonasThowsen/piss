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

(* ACP session/load replays the complete harness transcript before returning its
   response. Older workers persisted those notifications as fresh events. Drop
   every finished load attempt at read time so already-durable replay does not
   reappear as new agent output after a worker restart. Scanning backwards also
   handles a bounded recent page that begins in the middle of a long replay. *)
let replayed_timeline_update kind =
  List.mem
    [
      "acp.user_message_chunk";
      "acp.agent_message_chunk";
      "acp.tool_call";
      "acp.tool_call_update";
    ]
    kind ~equal:String.equal

let without_session_load_replays events =
  let rec loop dropping kept = function
    | [] -> kept
    | event :: rest ->
        let kind = Event_decode.kind event in
        if
          String.equal kind "acp.session.loaded"
          || String.equal kind "acp.session.load_failed"
        then loop true (event :: kept) rest
        else if dropping && String.equal kind "acp.initialize" then
          loop false (event :: kept) rest
        else if dropping && replayed_timeline_update kind then
          loop true kept rest
        else loop dropping (event :: kept) rest
  in
  loop false [] (List.rev events)

type projection = Timeline_projection.projection

let projection events =
  events |> without_session_load_replays
  |> List.filter_map ~f:Event_decode.update
  |> Timeline_projection.project_updates

let append_projection projected event =
  let kind = Event_decode.kind event in
  if
    String.equal kind "acp.session.loaded"
    || String.equal kind "acp.session.load_failed"
  then None
  else
    Some
      (Option.value_map
         (Event_decode.update event)
         ~default:projected
         ~f:(Timeline_projection.apply_update projected))

let projection_entries = Timeline_projection.projection_entries
let project events = projection events |> projection_entries
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

let has_conversation_boundary events =
  let rec loop accepted completed = function
    | [] -> false
    | User { command_id; _ } :: rest ->
        if completed then true
        else loop (Set.add accepted command_id) completed rest
    | Command_state { command_id; state; _ } :: rest ->
        let completed =
          completed
          || Set.mem accepted command_id
             &&
             match state with
             | Completed | Cancelled | Rejected -> true
             | Received | Accepted | Dispatched | Acknowledged | Ambiguous ->
                 false
        in
        loop accepted completed rest
    | Agent _ :: rest
    | Tool _ :: rest
    | Permission_requested _ :: rest
    | Permission_resolved _ :: rest
    | Permission_cancelled _ :: rest ->
        loop accepted completed rest
  in
  loop String.Set.empty false (project events)

let has_unresolved_recoveries events =
  let accepted, recovered =
    List.fold events ~init:(String.Set.empty, String.Set.empty)
      ~f:(fun (accepted, recovered) event ->
        let accepted =
          Option.value_map
            (Event_decode.accepted_command_id event)
            ~default:accepted ~f:(Set.add accepted)
        in
        let recovered =
          Option.value_map
            (Event_decode.recovered_command_id event)
            ~default:recovered ~f:(Set.add recovered)
        in
        (accepted, recovered))
  in
  not (Set.is_subset recovered ~of_:accepted)

let initial_history_is_complete events =
  has_conversation_boundary events && not (has_unresolved_recoveries events)
