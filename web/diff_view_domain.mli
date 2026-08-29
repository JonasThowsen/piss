open! Core

val diff_page_line_count : int
(** The source-row count rendered in one browser diff page. The patch remains
    fully accounted for; paging bounds only the retained VDOM row model. *)

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

val parse_unified_patch : ?first_line:int -> string -> parsed
(** Parses one source-row page of a unified Git patch into numbered review
    hunks. Metadata preambles are ignored, while totals cover the full patch. *)

val split_rows : hunk -> split_row list
(** Pairs each contiguous deletion/addition run into the two review columns. *)

val word_segments :
  original:string -> revised:string -> word_segment list * word_segment list
(** Returns a linear-time, bounded word-like emphasis split for one side of a
    changed line. *)

val change_counts : parsed -> int * int
(** Counts added and deleted source rows across the full patch without
    re-parsing a rendered view. *)
