open! Core

let fail message = raise_s [%message message]

let () =
  let open Timeline_projection in
  let idless_entries =
    project
      [
        User_update { sequence = 1L; command_id = "command-1"; text = "Run" };
        Agent_chunk { sequence = 2L; message_id = ""; text = "Hello " };
        Agent_chunk { sequence = 3L; message_id = ""; text = "world" };
      ]
  in
  (match idless_entries with
  | [
   User _; Agent { message_id = "command-command-1"; text = "Hello world"; _ };
  ] ->
      ()
  | _ -> fail "id-less ACP chunks were not grouped by command");
  let moved_idless_entries =
    project
      [
        User_update { sequence = 1L; command_id = "command-1"; text = "Run" };
        Agent_chunk { sequence = 2L; message_id = ""; text = "Working" };
        Tool_call
          {
            sequence = 3L;
            tool_call_id = "tool-between";
            title = "Check";
            input = "";
            status = "completed";
            artifacts = [];
          };
        Agent_chunk { sequence = 4L; message_id = ""; text = "Done" };
      ]
  in
  (match moved_idless_entries with
  | [
   User _;
   Agent { sequence = 2L; message_id = "command-command-1"; text = "Working" };
   Tool _;
   Agent { sequence = 4L; message_id = "command-command-1"; text = "Done" };
  ] ->
      ()
  | _ -> fail "id-less response segments did not remain around the tool call");
  let grouped =
    group_timeline
      [
        Command_state { sequence = 1L; command_id = "before"; state = Accepted };
        Tool
          {
            sequence = 2L;
            tool_call_id = "tool-a";
            title = "Inspect";
            input = "read";
            output = "";
            status = "in_progress";
            artifacts = [];
          };
        Permission_resolved
          { sequence = 3L; request_id = "permission"; option_id = None };
        Agent { sequence = 4L; message_id = "agent-a"; text = "Done" };
        Command_state { sequence = 5L; command_id = "after"; state = Completed };
        User { sequence = 6L; command_id = "next"; text = "Continue" };
      ]
  in
  (match grouped with
  | [
   Activity_group
     {
       key = "activity-after:leading";
       sequence = 1L;
       entries =
         [ Command_state { sequence = 1L; _ }; Tool { sequence = 2L; _ } ];
     };
   Message_entry (Agent { sequence = 4L; _ });
   Activity_group
     {
       key = "activity-after:agent:agent-a:4";
       sequence = 5L;
       entries = [ Command_state { sequence = 5L; _ } ];
     };
   Message_entry (User { sequence = 6L; _ });
  ] ->
      ()
  | _ -> fail "timeline activity was not grouped between message boundaries");
  let stable_leading_key entries =
    match group_timeline entries with
    | [ Activity_group { key; _ } ] -> key
    | _ -> fail "leading activity did not form one group"
  in
  let tool =
    Tool
      {
        sequence = 2L;
        tool_call_id = "stable-tool";
        title = "Stable";
        input = "";
        output = "";
        status = "in_progress";
        artifacts = [];
      }
  in
  let before = stable_leading_key [ tool ] in
  let after =
    stable_leading_key
      [
        Command_state { sequence = 1L; command_id = "older"; state = Accepted };
        tool;
      ]
  in
  if not (String.equal before after) then
    fail "prepending contiguous activity changed its stable group key";
  let entries =
    project
      [
        Agent_chunk { sequence = 1L; message_id = "message-1"; text = "Hello " };
        Tool_call
          {
            sequence = 2L;
            tool_call_id = "tool-1";
            title = "Run tests";
            input = "dune runtest";
            status = "in_progress";
            artifacts = [];
          };
        Agent_chunk { sequence = 3L; message_id = "message-1"; text = "world" };
        Tool_call_update
          {
            sequence = 4L;
            tool_call_id = "tool-1";
            title = None;
            input = None;
            output = Some "partial";
            status = None;
            artifacts = [ Terminal { terminal_id = "proof"; text = None } ];
          };
        Tool_call_update
          {
            sequence = 5L;
            tool_call_id = "tool-1";
            title = Some "Durability proof";
            input = None;
            output = Some "2 tests passed";
            status = Some "completed";
            artifacts =
              [
                Terminal { terminal_id = "proof"; text = None };
                Location { path = "proof.txt"; line = None; text = None };
              ];
          };
      ]
  in
  match entries with
  | [
   Agent { sequence = 1L; message_id = "message-1"; text = "Hello " };
   Tool
     {
       sequence = 2L;
       tool_call_id = "tool-1";
       title = "Durability proof";
       input = "dune runtest";
       output = "partial\n2 tests passed";
       status = "completed";
       artifacts =
         [
           Terminal { terminal_id = "proof"; text = None };
           Location { path = "proof.txt"; line = None; text = None };
         ];
     };
   Agent { sequence = 3L; message_id = "message-1"; text = "world" };
  ] ->
      let copied =
        tool_text ~input:"dune runtest" ~output:"partial\n2 tests passed"
          ~artifacts:
            [
              Terminal { terminal_id = "proof"; text = None };
              Location { path = "proof.txt"; line = None; text = None };
            ]
      in
      if
        not
          (String.is_substring copied ~substring:"terminal: proof"
          && String.is_substring copied ~substring:"location: proof.txt")
      then fail "full tool copy omitted typed artifacts"
  | _ ->
      fail
        "timeline projection did not preserve agent segments around the tool \
         row"
