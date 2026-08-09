open! Core

type inline =
  | Text of string
  | Code of string
  | Bold of string
  | Link of string * string

type block =
  | Paragraph of inline list list
  | Unordered_list of inline list list
  | Ordered_list of inline list list
  | Heading of int * inline list
  | Blockquote of inline list list
  | Fenced_code of { language : string; code : string }

let safe_link target =
  String.is_prefix target ~prefix:"http://"
  || String.is_prefix target ~prefix:"https://"

let earliest candidates =
  List.filter_opt candidates
  |> List.min_elt ~compare:(fun (left, _, _) (right, _, _) ->
      Int.compare left right)

let find_from text ~from pattern = String.substr_index ~pos:from text ~pattern

let rec inline_from text cursor acc =
  let length = String.length text in
  if cursor >= length then List.rev acc
  else
    let code =
      Option.bind (find_from text ~from:cursor "`") ~f:(fun start ->
          Option.map
            (find_from text ~from:(start + 1) "`")
            ~f:(fun stop ->
              ( start,
                stop + 1,
                Code (String.sub text ~pos:(start + 1) ~len:(stop - start - 1))
              )))
    in
    let bold =
      Option.bind (find_from text ~from:cursor "**") ~f:(fun start ->
          Option.map
            (find_from text ~from:(start + 2) "**")
            ~f:(fun stop ->
              ( start,
                stop + 2,
                Bold (String.sub text ~pos:(start + 2) ~len:(stop - start - 2))
              )))
    in
    let link =
      Option.bind (find_from text ~from:cursor "[") ~f:(fun start ->
          Option.bind
            (find_from text ~from:(start + 1) "](")
            ~f:(fun middle ->
              Option.map
                (find_from text ~from:(middle + 2) ")")
                ~f:(fun stop ->
                  let label =
                    String.sub text ~pos:(start + 1) ~len:(middle - start - 1)
                  in
                  let target =
                    String.sub text ~pos:(middle + 2) ~len:(stop - middle - 2)
                  in
                  let token =
                    if safe_link target then Link (label, target)
                    else Text label
                  in
                  (start, stop + 1, token))))
    in
    match earliest [ code; bold; link ] with
    | None -> List.rev (Text (String.drop_prefix text cursor) :: acc)
    | Some (start, stop, token) ->
        let acc =
          if start = cursor then acc
          else Text (String.sub text ~pos:cursor ~len:(start - cursor)) :: acc
        in
        inline_from text stop (token :: acc)

let inline text = inline_from text 0 []

let heading line =
  let rec hashes index =
    if index < String.length line && index < 4 && Char.equal line.[index] '#'
    then hashes (index + 1)
    else index
  in
  let count = hashes 0 in
  if count > 0 && count < String.length line && Char.equal line.[count] ' ' then
    Some
      (Heading
         (Int.min 6 (count + 2), inline (String.drop_prefix line (count + 1))))
  else None

let unordered line =
  let stripped = String.lstrip line in
  if
    String.is_prefix stripped ~prefix:"- "
    || String.is_prefix stripped ~prefix:"* "
  then Some (inline (String.drop_prefix stripped 2))
  else None

let ordered line =
  let stripped = String.lstrip line in
  match String.index stripped '.' with
  | None -> None
  | Some index
    when index > 0
         && index + 1 < String.length stripped
         && Char.equal stripped.[index + 1] ' '
         && String.for_all (String.prefix stripped index) ~f:Char.is_digit ->
      Some (inline (String.drop_prefix stripped (index + 2)))
  | Some _ -> None

let quote line =
  if String.is_prefix line ~prefix:"> " then
    Some (inline (String.drop_prefix line 2))
  else if String.is_prefix line ~prefix:">" then
    Some (inline (String.drop_prefix line 1))
  else None

let plain_block lines =
  match lines with
  | [ line ] -> Option.value (heading line) ~default:(Paragraph [ inline line ])
  | _ -> (
      match List.map lines ~f:unordered |> Option.all with
      | Some items -> Unordered_list items
      | None -> (
          match List.map lines ~f:ordered |> Option.all with
          | Some items -> Ordered_list items
          | None -> (
              match List.map lines ~f:quote |> Option.all with
              | Some items -> Blockquote items
              | None -> Paragraph (List.map lines ~f:inline))))

let normalize text = String.substr_replace_all text ~pattern:"\r\n" ~with_:"\n"

let parse text =
  let lines = String.split_lines (normalize text) in
  let flush plain blocks =
    if List.is_empty plain then blocks
    else plain_block (List.rev plain) :: blocks
  in
  let rec loop lines plain blocks =
    match lines with
    | [] -> List.rev (flush plain blocks)
    | line :: rest when String.is_prefix line ~prefix:"```" -> (
        let language = String.drop_prefix line 3 |> String.strip in
        let rec fenced code = function
          | [] -> None
          | closing :: tail when String.is_prefix closing ~prefix:"```" ->
              Some (List.rev code, tail)
          | code_line :: tail -> fenced (code_line :: code) tail
        in
        match fenced [] rest with
        | None -> loop rest (line :: plain) blocks
        | Some (code, tail) ->
            let blocks = flush plain blocks in
            let language =
              if String.is_empty language then "Text" else language
            in
            loop tail []
              (Fenced_code { language; code = String.concat code ~sep:"\n" }
              :: blocks))
    | line :: rest when String.is_empty (String.strip line) ->
        loop rest [] (flush plain blocks)
    | line :: rest -> loop rest (line :: plain) blocks
  in
  loop lines [] []
