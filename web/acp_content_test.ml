open! Core

let fail message = raise_s [%message message]

let decode body =
  match
    Acp_content.tool_content ~path:"content" (Yojson.Safe.from_string body)
  with
  | Ok value -> value
  | Error message -> fail message

let expect_error body substring =
  match
    Acp_content.tool_content ~path:"content" (Yojson.Safe.from_string body)
  with
  | Error message when String.is_substring message ~substring -> ()
  | Error message -> fail ("unexpected artifact error: " ^ message)
  | Ok _ -> fail ("invalid artifact was accepted: " ^ substring)

let () =
  let output, artifacts =
    decode
      {|[
        {"type":"text","text":"tool output"},
        {"type":"diff","path":"/work/a.ml","oldText":"old","newText":"new"},
        {"type":"terminal","terminalId":"term-1","text":"retained"},
        {"type":"content","content":{"type":"image","mimeType":"image/png","data":"aGVsbG8="}},
        {"type":"content","content":{"type":"resource","resource":{"uri":"file:///work/report.md","name":"Report","text":"summary"}}}
      ]|}
  in
  if not (String.equal output "tool output") then fail "text output was lost";
  (match artifacts with
  | [
   Acp_content.Diff { path = "/work/a.ml"; before = "old"; after = "new" };
   Terminal { terminal_id = "term-1"; text = Some "retained" };
   Image image;
   Resource
     {
       uri = "file:///work/report.md";
       name = Some "Report";
       text = Some "summary";
     };
  ]
    when String.equal (Image_attachment.mime_type image) "image/png" ->
      ()
  | _ -> fail "typed ACP artifacts were not preserved");
  let locations =
    match
      Acp_content.locations ~path:"update"
        [
          ( "locations",
            Yojson.Safe.from_string
              {|[{"path":"/work/a.ml","line":7,"text":"changed"}]|} );
        ]
    with
    | Ok values -> values
    | Error message -> fail message
  in
  (match locations with
  | [ Location { path = "/work/a.ml"; line = Some 7; text = Some "changed" } ]
    ->
      ()
  | _ -> fail "typed location was not decoded");
  expect_error
    {|[{"type":"image","mimeType":"image/svg+xml","data":"aGVsbG8="}]|}
    "Unsupported image type";
  expect_error {|[{"type":"image","mimeType":"image/png","data":"not-base64"}]|}
    "valid base64"
