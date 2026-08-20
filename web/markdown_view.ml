open! Core
open! Bonsai_web.Cont

let class_ name = Vdom.Attr.class_ name
let text = Vdom.Node.text

type cached_parse = {
  body : string;
  blocks : Markdown_syntax.block list;
  inserted : int;
}

let parse_cache_capacity = 512
let parse_cache_byte_capacity = 16 * 1024 * 1024
let markdown_body_limit = 1024 * 1024
let parse_cache_clock = ref 0
let parse_cache = ref String.Map.empty

let parse_cache_bytes cache =
  Map.fold cache ~init:0 ~f:(fun ~key:_ ~data:cached bytes ->
      bytes + String.length cached.body)

let trim_parse_cache cache =
  let rec trim cache =
    if
      Map.length cache <= parse_cache_capacity
      && parse_cache_bytes cache <= parse_cache_byte_capacity
    then cache
    else
      match
        Map.to_alist cache
        |> List.min_elt ~compare:(fun (_, left) (_, right) ->
            Int.compare left.inserted right.inserted)
      with
      | None -> cache
      | Some (item_key, _) -> trim (Map.remove cache item_key)
  in
  trim cache

let parse ~item_key body =
  match Map.find !parse_cache item_key with
  | Some cached when String.equal cached.body body -> cached.blocks
  | None | Some _ ->
      Int.incr parse_cache_clock;
      let blocks = Markdown_syntax.parse body in
      parse_cache :=
        Map.set !parse_cache ~key:item_key
          ~data:{ body; blocks; inserted = !parse_cache_clock }
        |> trim_parse_cache;
      blocks

let copy_button ~key ~kind ~value ~copy_feedback ~on_copy =
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
        Vdom.Attr.create "aria-label" (label ^ " " ^ kind);
        Vdom.Attr.on_click (fun _ -> on_copy ~key ~text:value);
      ]
    [ Vdom.Node.b [ text (String.uppercase label) ] ]

let render_inline ~key ~copy_feedback ~on_copy index = function
  | Markdown_syntax.Text value -> text value
  | Code value -> Vdom.Node.code [ text value ]
  | Bold value -> Vdom.Node.strong [ text value ]
  | Link (label, target) ->
      let copy_key = Printf.sprintf "%s-link-%d" key index in
      Vdom.Node.span
        ~attrs:[ class_ "markdown-link-with-copy" ]
        [
          Vdom.Node.a
            ~attrs:
              [
                Vdom.Attr.href target;
                Vdom.Attr.create "target" "_blank";
                Vdom.Attr.create "rel" "noopener noreferrer";
              ]
            [ text label ];
          copy_button ~key:copy_key ~kind:"link" ~value:target ~copy_feedback
            ~on_copy;
        ]

let render_inlines ~key ~copy_feedback ~on_copy values =
  List.mapi values ~f:(render_inline ~key ~copy_feedback ~on_copy)

let with_breaks ~key ~copy_feedback ~on_copy lines =
  List.concat_mapi lines ~f:(fun index line ->
      (if index = 0 then [] else [ Vdom.Node.create "br" [] ])
      @ render_inlines
          ~key:(Printf.sprintf "%s-line-%d" key index)
          ~copy_feedback ~on_copy line)

let list ~key ~copy_feedback ~on_copy tag items =
  Vdom.Node.create tag
    (List.mapi items ~f:(fun index item ->
         Vdom.Node.li ~key:(Int.to_string index)
           (render_inlines
              ~key:(Printf.sprintf "%s-item-%d" key index)
              ~copy_feedback ~on_copy item)))

let render_block ~item_key ~copy_feedback ~on_copy index block =
  let key = Printf.sprintf "%s-block-%d" item_key index in
  match block with
  | Markdown_syntax.Paragraph lines ->
      Vdom.Node.section ~key
        ~attrs:[ class_ "markdown-block markdown-text-block" ]
        [ Vdom.Node.p (with_breaks ~key ~copy_feedback ~on_copy lines) ]
  | Unordered_list items ->
      Vdom.Node.section ~key
        ~attrs:[ class_ "markdown-block markdown-text-block" ]
        [ list ~key ~copy_feedback ~on_copy "ul" items ]
  | Ordered_list items ->
      Vdom.Node.section ~key
        ~attrs:[ class_ "markdown-block markdown-text-block" ]
        [ list ~key ~copy_feedback ~on_copy "ol" items ]
  | Heading (level, contents) ->
      Vdom.Node.section ~key
        ~attrs:[ class_ "markdown-block markdown-text-block" ]
        [
          Vdom.Node.create
            ("h" ^ Int.to_string level)
            (render_inlines ~key ~copy_feedback ~on_copy contents);
        ]
  | Blockquote lines ->
      Vdom.Node.section ~key
        ~attrs:[ class_ "markdown-block markdown-text-block" ]
        [
          Vdom.Node.create "blockquote"
            (with_breaks ~key ~copy_feedback ~on_copy lines);
        ]
  | Fenced_code { language; code } ->
      Vdom.Node.section ~key
        ~attrs:[ class_ "markdown-block markdown-code-block" ]
        [
          Vdom.Node.span
            ~attrs:[ class_ "markdown-code-language" ]
            [ text language ];
          copy_button ~key ~kind:"code block" ~value:code ~copy_feedback
            ~on_copy;
          Vdom.Node.pre [ Vdom.Node.code [ text code ] ];
        ]

let render ~item_key ~copy_feedback ~on_copy body =
  if String.length body > markdown_body_limit then
    Vdom.Node.pre
      ~attrs:[ class_ "message-body markdown-body markdown-oversized" ]
      [ text body ]
  else
    parse ~item_key body
    |> List.mapi ~f:(render_block ~item_key ~copy_feedback ~on_copy)
    |> Vdom.Node.div ~attrs:[ class_ "message-body markdown-body" ]
