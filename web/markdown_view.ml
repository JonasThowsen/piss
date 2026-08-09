open! Core
open! Bonsai_web.Cont

let class_ name = Vdom.Attr.class_ name
let text = Vdom.Node.text

let copy_button ~key ~code ~copy_feedback ~on_copy =
  let status =
    match copy_feedback with
    | Some (candidate, status) when String.equal candidate key -> Some status
    | _ -> None
  in
  let label, class_name =
    match status with
    | None -> ("Copy", "")
    | Some Clipboard.Copied -> ("Copied", " copied")
    | Some Failed -> ("Copy failed", " failed")
  in
  Vdom.Node.button
    ~attrs:
      [
        class_ ("markdown-copy" ^ class_name);
        Vdom.Attr.create "type" "button";
        Vdom.Attr.create "aria-label" (label ^ " code block");
        Vdom.Attr.on_click (fun _ -> on_copy ~key ~text:code);
      ]
    [ Vdom.Node.b [ text (String.uppercase label) ] ]

let render_inline = function
  | Markdown_syntax.Text value -> text value
  | Code value -> Vdom.Node.code [ text value ]
  | Bold value -> Vdom.Node.strong [ text value ]
  | Link (label, target) ->
      Vdom.Node.a
        ~attrs:
          [
            Vdom.Attr.href target;
            Vdom.Attr.create "target" "_blank";
            Vdom.Attr.create "rel" "noopener noreferrer";
          ]
        [ text label ]

let render_inlines values = List.map values ~f:render_inline

let with_breaks lines =
  List.concat_mapi lines ~f:(fun index line ->
      (if index = 0 then [] else [ Vdom.Node.create "br" [] ])
      @ render_inlines line)

let list tag items =
  Vdom.Node.create tag
    (List.mapi items ~f:(fun index item ->
         Vdom.Node.li ~key:(Int.to_string index) (render_inlines item)))

let render_block ~item_key ~copy_feedback ~on_copy index block =
  let key = Printf.sprintf "%s-block-%d" item_key index in
  match block with
  | Markdown_syntax.Paragraph lines ->
      Vdom.Node.section ~key
        ~attrs:[ class_ "markdown-block markdown-text-block" ]
        [ Vdom.Node.p (with_breaks lines) ]
  | Unordered_list items ->
      Vdom.Node.section ~key
        ~attrs:[ class_ "markdown-block markdown-text-block" ]
        [ list "ul" items ]
  | Ordered_list items ->
      Vdom.Node.section ~key
        ~attrs:[ class_ "markdown-block markdown-text-block" ]
        [ list "ol" items ]
  | Heading (level, contents) ->
      Vdom.Node.section ~key
        ~attrs:[ class_ "markdown-block markdown-text-block" ]
        [
          Vdom.Node.create ("h" ^ Int.to_string level) (render_inlines contents);
        ]
  | Blockquote lines ->
      Vdom.Node.section ~key
        ~attrs:[ class_ "markdown-block markdown-text-block" ]
        [ Vdom.Node.create "blockquote" (with_breaks lines) ]
  | Fenced_code { language; code } ->
      Vdom.Node.section ~key
        ~attrs:[ class_ "markdown-block markdown-code-block" ]
        [
          Vdom.Node.span
            ~attrs:[ class_ "markdown-code-language" ]
            [ text language ];
          copy_button ~key ~code ~copy_feedback ~on_copy;
          Vdom.Node.pre [ Vdom.Node.code [ text code ] ];
        ]

let render ~item_key ~copy_feedback ~on_copy body =
  Markdown_syntax.parse body
  |> List.mapi ~f:(render_block ~item_key ~copy_feedback ~on_copy)
  |> Vdom.Node.div ~attrs:[ class_ "message-body markdown-body" ]
