open! Core

let fail message = raise_s [%message message]

let () =
  let open Timeline_projection in
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
   Agent { sequence = 1L; message_id = "message-1"; text = "Hello world" };
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
      fail "timeline projection did not aggregate stable message and tool rows"
