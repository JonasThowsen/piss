(** Bounded, sandboxed Git collection and deterministic Audit journey selection.
*)

type status_entry = {
  path : string;
  previous_path : string option;
  index_status : char;
  worktree_status : char;
}

type file = {
  path : string;
  previous_path : string option;
  index_status : char;
  worktree_status : char;
  patch : string;
  truncated : bool;
  binary : bool;
  role : string;
  reason : string;
  journey_index : int option;
}

type snapshot = {
  generated_at : int64;
  files : file list;
  total_files : int;
  truncated : bool;
}

val parse_porcelain : string -> status_entry list
val role_and_reason : string -> string * string
val select_journey : status_entry list -> string list
val snapshot_to_yojson : snapshot -> Yojson.Safe.t

val collect :
  process_mgr:_ Eio_unix.Process.mgr ->
  clock:_ Eio.Time.clock ->
  root:string ->
  (snapshot, string) result
(** [collect] identity-checks [root] and its Git metadata, then runs fixed-argv
    Git commands against a sanitized Git view in a read-only, networkless
    Landlock sandbox. *)

val collect_for_test :
  process_mgr:_ Eio_unix.Process.mgr ->
  clock:_ Eio.Time.clock ->
  root:string ->
  before_sanitized:(unit -> unit) ->
  (snapshot, string) result
(** Deterministic race seam for collector regression tests. Production HTTP
    routes use only [collect]. *)
