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
  let leading_idless_entries =
    project
      [
        Agent_chunk { sequence = 10L; message_id = ""; text = "checks" };
        Agent_chunk { sequence = 11L; message_id = ""; text = " passed" };
        Agent_chunk { sequence = 12L; message_id = ""; text = "; production" };
      ]
  in
  (match leading_idless_entries with
  | [ Agent { sequence = 10L; text = "checks passed; production"; _ } ] -> ()
  | _ -> fail "leading id-less ACP chunks were rendered as separate messages");
  let mixed_id_entries =
    project
      [
        Agent_chunk { sequence = 20L; message_id = "explicit"; text = "A" };
        Agent_chunk { sequence = 21L; message_id = ""; text = "B" };
        Agent_chunk { sequence = 22L; message_id = ""; text = "C" };
        Agent_chunk { sequence = 23L; message_id = "explicit"; text = "D" };
        Agent_chunk { sequence = 24L; message_id = ""; text = "E" };
      ]
  in
  (match mixed_id_entries with
  | [
   Agent { sequence = 20L; message_id = "explicit"; text = "A" };
   Agent { sequence = 21L; text = "BC"; _ };
   Agent { sequence = 23L; message_id = "explicit"; text = "D" };
   Agent { sequence = 24L; text = "E"; _ };
  ] ->
      ()
  | _ -> fail "explicit and leading id-less agent messages were combined");
  let leading_tool_boundary =
    project
      [
        Agent_chunk { sequence = 30L; message_id = ""; text = "before " };
        Agent_chunk { sequence = 31L; message_id = ""; text = "tool" };
        Tool_call
          {
            sequence = 32L;
            tool_call_id = "leading-tool";
            title = "Inspect";
            input = "";
            status = "completed";
            artifacts = [];
          };
        Agent_chunk { sequence = 33L; message_id = ""; text = "after " };
        Agent_chunk { sequence = 34L; message_id = ""; text = "tool" };
      ]
  in
  (match leading_tool_boundary with
  | [
   Agent { sequence = 30L; text = "before tool"; _ };
   Tool _;
   Agent { sequence = 33L; text = "after tool"; _ };
  ] ->
      ()
  | _ -> fail "tool boundary did not split leading id-less agent runs");
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
  let background_child state current_tool =
    ({
       id = "implementation";
       kind = Background_work.Step;
       label = "worker";
       state;
       activity =
         Some
           {
             state = Some "active";
             current_tool;
             turn_count = Some 2;
             tool_count = Some 7;
           };
       children = [];
     }
      : Background_work.node)
  in
  let background_snapshot state child =
    ({
       generated_at = 1L;
       omitted_runs = 0;
       omitted_children = 0;
       runs =
         [
           {
             id = "workflow-1";
             kind = Background_work.Workflow;
             label = "worker";
             state;
             activity = None;
             children = [ child ];
           };
         ];
     }
      : Background_work.t)
  in
  let background_entries =
    project
      [
        Background_work_snapshot
          {
            sequence = 35L;
            snapshot =
              background_snapshot Background_work.Running
                (background_child Background_work.Running (Some "bash"));
          };
        Background_work_snapshot
          {
            sequence = 36L;
            snapshot =
              background_snapshot Background_work.Complete
                (background_child Background_work.Complete None);
          };
      ]
  in
  (match background_entries with
  | [
   Background_work
     {
       sequence = 35L;
       run =
         {
           id = "workflow-1";
           state = Background_work.Complete;
           children = [ { state = Background_work.Complete; _ } ];
           _;
         };
     };
  ] ->
      ()
  | _ -> fail "background work snapshots did not update one stable run entry");
  (match group_timeline background_entries with
  | [ Message_entry (Background_work _) ] -> ()
  | _ -> fail "background work was hidden inside command activity");
  let cleared_background =
    project
      [
        Background_work_snapshot
          {
            sequence = 37L;
            snapshot =
              background_snapshot Background_work.Running
                (background_child Background_work.Running (Some "bash"));
          };
        Background_work_snapshot
          {
            sequence = 38L;
            snapshot =
              {
                generated_at = 2L;
                omitted_runs = 0;
                omitted_children = 0;
                runs = [];
              };
          };
      ]
  in
  if not (List.is_empty cleared_background) then
    fail "an untracked live background run remained visible forever";
  let interleaved_background =
    project
      [
        Agent_chunk { sequence = 39L; message_id = "stream"; text = "still " };
        Background_work_snapshot
          {
            sequence = 40L;
            snapshot =
              background_snapshot Background_work.Running
                (background_child Background_work.Running (Some "bash"));
          };
        Agent_chunk { sequence = 41L; message_id = "stream"; text = "working" };
        Background_work_snapshot
          {
            sequence = 42L;
            snapshot =
              background_snapshot Background_work.Complete
                (background_child Background_work.Complete None);
          };
      ]
  in
  (match interleaved_background with
  | [
   Agent { sequence = 39L; text = "still working"; _ };
   Background_work
     { sequence = 40L; run = { state = Background_work.Complete; _ } };
  ] ->
      ()
  | _ ->
      fail
        "background progress split an agent message or moved out of \
         chronological position");
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
