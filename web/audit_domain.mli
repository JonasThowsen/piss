type file = {
  path : string;
  previous_path : string option;
  index_status : string;
  worktree_status : string;
  patch : string;
  truncated : bool;
  binary : bool;
  role : string;
  reason : string;
  journey_index : int option;
}

type t = {
  generated_at : float;
  files : file list;
  total_files : int;
  accounted_files : int;
  highlighted_files : int;
  truncated : bool;
}

type request = { session_id : string; generation : int }

type load_state =
  | Dormant
  | Loading of request
  | Loaded of request * t
  | Failed of request * string

type load_action =
  | Start of request
  | Succeeded of request * t
  | Rejected of request * string
  | Deactivate

val decode : string -> (t, string) result
val journey : t -> file list
val apply_load : 'a -> load_state -> load_action -> load_state
val snapshot_for : load_state -> session_id:string -> t option
