open! Core

let fail message = raise_s [%message message]

let () =
  let open Markdown_syntax in
  let source =
    "# Heading\n\n\
     First **bold** and `code` with [safe](https://example.test).\n"
    ^ "Second line with [unsafe](javascript:alert(1)).\n\n"
    ^ "- one\n- two\n\n> quoted\n> again\n\n```ocaml\nlet value = 1\n```"
  in
  match parse source with
  | [
   Heading (3, [ Text "Heading" ]);
   Paragraph
     [
       [
         Text "First ";
         Bold "bold";
         Text " and ";
         Code "code";
         Text " with ";
         Link ("safe", "https://example.test");
         Text ".";
       ];
       [ Text "Second line with "; Text "unsafe"; Text ")." ];
     ];
   Unordered_list [ [ Text "one" ]; [ Text "two" ] ];
   Blockquote [ [ Text "quoted" ]; [ Text "again" ] ];
   Fenced_code { language = "ocaml"; code = "let value = 1" };
  ] ->
      ()
  | _ -> fail "Markdown basics or safe-link filtering changed"
