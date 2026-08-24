open! Core

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
  | Background_work_snapshot of {
      sequence : int64;
      snapshot : Background_work.t;
    }
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
  | Background_work of { sequence : int64; run : Background_work.node }
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

let entry_sequence = function
  | User { sequence; _ }
  | Agent { sequence; _ }
  | Background_work { sequence; _ }
  | Tool { sequence; _ }
  | Command_state { sequence; _ }
  | Permission_requested { sequence; _ }
  | Permission_resolved { sequence; _ }
  | Permission_cancelled { sequence; _ } ->
      sequence

let group_timeline entries =
  let boundary_key = function
    | User { command_id; _ } -> "user:" ^ command_id
    | Agent { sequence; message_id; _ } ->
        "agent:" ^ message_id ^ ":" ^ Int64.to_string sequence
    | Background_work { run; _ } -> "background:" ^ run.id
    | Tool _ | Command_state _ | Permission_requested _ | Permission_resolved _
    | Permission_cancelled _ ->
        assert false
  in
  let flush boundary activity blocks =
    match activity with
    | None -> blocks
    | Some (sequence, entries) ->
        let boundary = Option.value boundary ~default:"leading" in
        Activity_group
          {
            key = "activity-after:" ^ boundary;
            sequence;
            entries = List.rev entries;
          }
        :: blocks
  in
  let rec loop boundary activity blocks = function
    | [] -> List.rev (flush boundary activity blocks)
    | ((User _ | Agent _ | Background_work _) as entry) :: rest ->
        let blocks = Message_entry entry :: flush boundary activity blocks in
        loop (Some (boundary_key entry)) None blocks rest
    | ((Tool _ | Command_state _) as entry) :: rest ->
        let activity =
          match activity with
          | None -> Some (entry_sequence entry, [ entry ])
          | Some (sequence, entries) -> Some (sequence, entry :: entries)
        in
        loop boundary activity blocks rest
    | (Permission_requested _ | Permission_resolved _ | Permission_cancelled _)
      :: rest ->
        loop boundary activity blocks rest
  in
  loop None None [] entries

type agent_group =
  | Explicit_message of string
  | Command_message of string
  | Leading_idless of int64

type projection = {
  order : string list;
  entries : entry String.Map.t;
  current_command : string option;
  current_agent_group : agent_group option;
}

let add_or_replace state key entry =
  let order =
    if Map.mem state.entries key then state.order else key :: state.order
  in
  { state with order; entries = Map.set state.entries ~key ~data:entry }

let remove_entry state key =
  {
    state with
    order = List.filter state.order ~f:(Fn.non (String.equal key));
    entries = Map.remove state.entries key;
  }

let interrupt_agent state = { state with current_agent_group = None }

let append_unique current incoming =
  List.fold incoming ~init:current ~f:(fun values value ->
      if List.mem values value ~equal:Acp_content.equal then values
      else values @ [ value ])

let append_output current = function
  | Some chunk when not (String.is_empty chunk) ->
      if String.is_empty current then chunk else current ^ "\n" ^ chunk
  | None | Some _ -> current

let equal_agent_group left right =
  match (left, right) with
  | Explicit_message left, Explicit_message right
  | Command_message left, Command_message right ->
      String.equal left right
  | Leading_idless left, Leading_idless right -> Int64.equal left right
  | Explicit_message _, (Command_message _ | Leading_idless _)
  | Command_message _, (Explicit_message _ | Leading_idless _)
  | Leading_idless _, (Explicit_message _ | Command_message _) ->
      false

let empty_projection =
  {
    order = [];
    entries = String.Map.empty;
    current_command = None;
    current_agent_group = None;
  }

let updated_agent_entry state ~message_id ~text =
  List.find_map state.order ~f:(fun key ->
      match Map.find state.entries key with
      | Some (Agent previous) when String.equal previous.message_id message_id
        ->
          Some (key, Agent { previous with text = previous.text ^ text })
      | Some _ | None -> None)

let apply_update state update =
  match update with
  | User_update { sequence; command_id; text } ->
      add_or_replace
        {
          state with
          current_command = Some command_id;
          current_agent_group = None;
        }
        ("event:user:" ^ Int64.to_string sequence)
        (User { sequence; command_id; text })
  | Agent_chunk { sequence; message_id; text } ->
      let group, message_id =
        if not (String.is_empty message_id) then
          (Explicit_message message_id, message_id)
        else
          match state.current_command with
          | Some command_id ->
              (Command_message command_id, "command-" ^ command_id)
          | None -> (
              match state.current_agent_group with
              | Some (Leading_idless first_sequence as group) ->
                  (group, "event-" ^ Int64.to_string first_sequence)
              | Some (Explicit_message _ | Command_message _) | None ->
                  (Leading_idless sequence, "event-" ^ Int64.to_string sequence)
              )
      in
      let same_group =
        Option.exists state.current_agent_group ~f:(fun previous ->
            equal_agent_group previous group)
      in
      let key, entry =
        match
          if same_group then updated_agent_entry state ~message_id ~text
          else None
        with
        | Some (key, entry) -> (key, entry)
        | None ->
            ( "event:agent:" ^ Int64.to_string sequence,
              Agent { sequence; message_id; text } )
      in
      let state = add_or_replace state key entry in
      { state with current_agent_group = Some group }
  | Background_work_snapshot { sequence; snapshot } ->
      let reported_ids =
        snapshot.runs
        |> List.map ~f:(fun (run : Background_work.node) -> run.id)
        |> String.Set.of_list
      in
      let state =
        Map.fold state.entries ~init:state ~f:(fun ~key ~data state ->
            match data with
            | Background_work { run; _ }
              when Background_work.is_running run.state
                   && not (Set.mem reported_ids run.id) ->
                remove_entry state key
            | User _ | Agent _ | Background_work _ | Tool _ | Command_state _
            | Permission_requested _ | Permission_resolved _
            | Permission_cancelled _ ->
                state)
      in
      List.fold snapshot.runs ~init:state ~f:(fun state run ->
          let key = "background:" ^ run.id in
          let entry =
            match Map.find state.entries key with
            | Some (Background_work previous) ->
                Background_work { previous with run }
            | Some _ | None -> Background_work { sequence; run }
          in
          add_or_replace state key entry)
  | Tool_call { sequence; tool_call_id; title; input; status; artifacts } ->
      let key = "tool:" ^ tool_call_id in
      let entry =
        match Map.find state.entries key with
        | Some (Tool previous) ->
            Tool
              {
                previous with
                title;
                input;
                status;
                artifacts = append_unique previous.artifacts artifacts;
              }
        | _ ->
            Tool
              {
                sequence;
                tool_call_id;
                title;
                input;
                output = "";
                status;
                artifacts;
              }
      in
      add_or_replace (interrupt_agent state) key entry
  | Tool_call_update
      { sequence; tool_call_id; title; input; output; status; artifacts } ->
      let key = "tool:" ^ tool_call_id in
      let entry =
        match Map.find state.entries key with
        | Some (Tool previous) ->
            Tool
              {
                previous with
                title = Option.value title ~default:previous.title;
                input = Option.value input ~default:previous.input;
                output = append_output previous.output output;
                status = Option.value status ~default:previous.status;
                artifacts = append_unique previous.artifacts artifacts;
              }
        | _ ->
            Tool
              {
                sequence;
                tool_call_id;
                title = Option.value title ~default:"Tool";
                input = Option.value input ~default:"";
                output = append_output "" output;
                status = Option.value status ~default:"in_progress";
                artifacts;
              }
      in
      add_or_replace (interrupt_agent state) key entry
  | Command_state_update { sequence; command_id; state = command_state } ->
      add_or_replace (interrupt_agent state)
        ("event:command:" ^ Int64.to_string sequence)
        (Command_state { sequence; command_id; state = command_state })
  | Permission_requested_update { sequence; request } ->
      add_or_replace (interrupt_agent state)
        ("event:permission:" ^ Int64.to_string sequence)
        (Permission_requested { sequence; request })
  | Permission_resolved_update { sequence; request_id; option_id } ->
      add_or_replace (interrupt_agent state)
        ("event:permission:" ^ Int64.to_string sequence)
        (Permission_resolved { sequence; request_id; option_id })
  | Permission_cancelled_update { sequence; request_id } ->
      add_or_replace (interrupt_agent state)
        ("event:permission:" ^ Int64.to_string sequence)
        (Permission_cancelled { sequence; request_id })

let projection_entries projected =
  List.rev_map projected.order ~f:(fun key ->
      Map.find_exn projected.entries key)

let project_updates updates =
  List.fold updates ~init:empty_projection ~f:apply_update

let project updates = project_updates updates |> projection_entries

let tool_text ~input ~output ~artifacts =
  List.filter
    (input :: output :: List.map artifacts ~f:Acp_content.copy_text)
    ~f:(Fn.non String.is_empty)
  |> String.concat ~sep:"\n"
