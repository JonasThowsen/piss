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
            artifacts = [ "terminal: proof" ];
          };
        Tool_call_update
          {
            sequence = 5L;
            tool_call_id = "tool-1";
            title = Some "Durability proof";
            input = None;
            output = Some "2 tests passed";
            status = Some "completed";
            artifacts = [ "terminal: proof"; "location: proof.txt" ];
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
       artifacts = [ "terminal: proof"; "location: proof.txt" ];
     };
  ] ->
      ()
  | _ ->
      fail "timeline projection did not aggregate stable message and tool rows"
