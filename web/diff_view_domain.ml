open! Core

(* An Audit patch can contain generated output. The complete patch remains
   inspectable, but each browser page retains only this many source rows. *)
let diff_page_line_count = 600

type line_kind = Context | Addition | Deletion

type line = {
  kind : line_kind;
  old_number : int option;
  new_number : int option;
  text : string;
}

type hunk = { header : string; lines : line list }

type parsed = {
  hunks : hunk list;
  first_line : int;
  rendered_line_count : int;
  total_line_count : int;
  additions : int;
  deletions : int;
}

type split_row = { left : line option; right : line option }
type word_segment = Plain of string | Emphasized of string

let parse_range value =
  let value = String.drop_prefix value 1 in
  match String.lsplit2 value ~on:',' with
  | Some (start, length) ->
      Option.both (Int.of_string_opt start) (Int.of_string_opt length)
  | None -> Option.map (Int.of_string_opt value) ~f:(fun start -> (start, 1))

let parse_hunk_header header =
  match
    String.split header ~on:' ' |> List.filter ~f:(Fn.non String.is_empty)
  with
  | _marker :: old_range :: new_range :: _ ->
      Option.both (parse_range old_range) (parse_range new_range)
  | [] | [ _ ] | [ _; _ ] -> None

let is_hunk_header line =
  String.is_prefix line ~prefix:"@@ " && Option.is_some (parse_hunk_header line)

let parse_unified_patch ?(first_line = 0) patch =
  let first_line = Int.max 0 first_line in
  let last_line = first_line + diff_page_line_count in
  let current_header = ref None in
  let current_lines = ref [] in
  let hunks = ref [] in
  let old_line = ref 0 in
  let new_line = ref 0 in
  let total_line_count = ref 0 in
  let additions = ref 0 in
  let deletions = ref 0 in
  let finish_hunk () =
    match (!current_header, !current_lines) with
    | Some header, _ :: _ ->
        hunks := { header; lines = List.rev !current_lines } :: !hunks;
        current_header := None;
        current_lines := []
    | None, _ | Some _, [] ->
        current_header := None;
        current_lines := []
  in
  let append kind text =
    let source_index = !total_line_count in
    incr total_line_count;
    (match kind with
    | Addition -> incr additions
    | Deletion -> incr deletions
    | Context -> ());
    if source_index >= first_line && source_index < last_line then
      let old_number, new_number =
        match kind with
        | Context -> (!old_line, !new_line)
        | Deletion -> (!old_line, 0)
        | Addition -> (0, !new_line)
      in
      let optional value = if value = 0 then None else Some value in
      current_lines :=
        {
          kind;
          old_number = optional old_number;
          new_number = optional new_number;
          text;
        }
        :: !current_lines
  in
  String.split_lines patch
  |> List.iter ~f:(fun source_line ->
      if is_hunk_header source_line then (
        finish_hunk ();
        current_header := Some source_line;
        match parse_hunk_header source_line with
        | Some ((old_start, _), (new_start, _)) ->
            old_line := old_start;
            new_line := new_start
        | None -> ())
      else
        match !current_header with
        | None -> ()
        | Some _ when String.is_prefix source_line ~prefix:"\\ No newline" -> ()
        | Some _ when String.is_prefix source_line ~prefix:"-" ->
            append Deletion (String.drop_prefix source_line 1);
            incr old_line
        | Some _ when String.is_prefix source_line ~prefix:"+" ->
            append Addition (String.drop_prefix source_line 1);
            incr new_line
        | Some _ when String.is_prefix source_line ~prefix:" " ->
            append Context (String.drop_prefix source_line 1);
            incr old_line;
            incr new_line
        | Some _ -> ());
  finish_hunk ();
  let hunks = List.rev !hunks in
  let rendered_line_count =
    List.sum (module Int) hunks ~f:(fun hunk -> List.length hunk.lines)
  in
  {
    hunks;
    first_line;
    rendered_line_count;
    total_line_count = !total_line_count;
    additions = !additions;
    deletions = !deletions;
  }

let split_rows hunk =
  let rows = ref [] in
  let pending_deletions = ref [] in
  let pending_additions = ref [] in
  let flush_changes () =
    let deletions = List.rev !pending_deletions in
    let additions = List.rev !pending_additions in
    let count = Int.max (List.length deletions) (List.length additions) in
    for index = 0 to count - 1 do
      rows :=
        { left = List.nth deletions index; right = List.nth additions index }
        :: !rows
    done;
    pending_deletions := [];
    pending_additions := []
  in
  List.iter hunk.lines ~f:(fun line ->
      match line.kind with
      | Deletion -> pending_deletions := line :: !pending_deletions
      | Addition -> pending_additions := line :: !pending_additions
      | Context ->
          flush_changes ();
          rows := { left = Some line; right = Some line } :: !rows);
  flush_changes ();
  List.rev !rows

let word_boundary character =
  Char.is_whitespace character
  || Char.equal character '.' || Char.equal character ','
  || Char.equal character ';' || Char.equal character ':'
  || Char.equal character '(' || Char.equal character ')'
  || Char.equal character '[' || Char.equal character ']'
  || Char.equal character '{' || Char.equal character '}'

let common_prefix left right =
  let limit = Int.min (String.length left) (String.length right) in
  let index = ref 0 in
  while !index < limit && Char.equal left.[!index] right.[!index] do
    incr index
  done;
  !index

let common_suffix left right prefix =
  let left_length = String.length left in
  let right_length = String.length right in
  let limit = Int.min (left_length - prefix) (right_length - prefix) in
  let index = ref 0 in
  while
    !index < limit
    && Char.equal
         left.[left_length - !index - 1]
         right.[right_length - !index - 1]
  do
    incr index
  done;
  !index

let expand_prefix_to_word text prefix =
  let index = ref prefix in
  while !index > 0 && not (word_boundary text.[!index - 1]) do
    decr index
  done;
  !index

let expand_suffix_to_word text suffix =
  let index = ref (String.length text - suffix) in
  while !index < String.length text && not (word_boundary text.[!index]) do
    incr index
  done;
  String.length text - !index

let segments text ~prefix ~suffix =
  let length = String.length text in
  let changed_length = length - prefix - suffix in
  let before = String.prefix text prefix in
  let changed = String.sub text ~pos:prefix ~len:changed_length in
  let after = String.drop_prefix text (prefix + changed_length) in
  List.filter_map
    [
      (if String.is_empty before then None else Some (Plain before));
      (if String.is_empty changed then None else Some (Emphasized changed));
      (if String.is_empty after then None else Some (Plain after));
    ]
    ~f:Fn.id

let word_segments ~original ~revised =
  if String.equal original revised then ([ Plain original ], [ Plain revised ])
  else
    let prefix = common_prefix original revised in
    let suffix = common_suffix original revised prefix in
    let original_prefix = expand_prefix_to_word original prefix in
    let revised_prefix = expand_prefix_to_word revised prefix in
    let original_suffix = expand_suffix_to_word original suffix in
    let revised_suffix = expand_suffix_to_word revised suffix in
    ( segments original ~prefix:original_prefix ~suffix:original_suffix,
      segments revised ~prefix:revised_prefix ~suffix:revised_suffix )

let change_counts parsed = (parsed.additions, parsed.deletions)
