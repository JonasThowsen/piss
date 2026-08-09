open! Core

type phase = Running_tool | Thinking | Awaiting_permission | Connecting | Idle

type tool = {
  sequence : int64;
  title : string;
  detail : string;
  status : string;
}

type t = { phase : phase; current : tool option; recent : tool list }

let tool_of_entry = function
  | Event_history.Tool { sequence; title; input; output; status; artifacts; _ }
    ->
      Some
        {
          sequence;
          title;
          detail = Timeline_projection.tool_text ~input ~output ~artifacts;
          status;
        }
  | _ -> None

let running tool =
  String.equal tool.status "pending" || String.equal tool.status "in_progress"

let derive ~(snapshot : Runtime_domain.t option) ~connecting ~events:_ ~entries
    =
  let tools = List.filter_map entries ~f:tool_of_entry |> List.rev in
  let current = List.find tools ~f:running in
  let recent =
    tools
    |> List.filter ~f:(fun tool ->
        Option.value_map current ~default:true ~f:(fun active ->
            not (Int64.equal active.sequence tool.sequence)))
    |> Fn.flip List.take 5
  in
  let pending_permission =
    not (List.is_empty (Event_history.pending_permissions entries))
  in
  let phase =
    if connecting then Connecting
    else if pending_permission then Awaiting_permission
    else if Option.is_some current then Running_tool
    else
      match snapshot with
      | Some { status = Runtime_domain.Running; _ } -> Thinking
      | Some { status = Requires_action; _ } -> Awaiting_permission
      | Some _ | None -> Idle
  in
  { phase; current; recent }

let phase_label = function
  | Running_tool -> "Running tool"
  | Thinking -> "Thinking"
  | Awaiting_permission -> "Awaiting permission"
  | Connecting -> "Connecting"
  | Idle -> "Idle"

let phase_detail model =
  match (model.phase, model.current) with
  | Running_tool, Some tool -> tool.title
  | Thinking, _ -> "The agent is reasoning about the next step."
  | Awaiting_permission, _ -> "The agent needs a permission decision."
  | Connecting, _ -> "Refreshing the selected runtime snapshot."
  | Idle, _ -> "No tool or agent run is active."
  | Running_tool, None -> "The agent is running a tool."
