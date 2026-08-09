(* Workspace file mention and resource types plus the pure helpers
   that validate them, build file:// URIs, and turn them into JSON.
   The filesystem IO (walking a directory, resolving a workspace
   path to an absolute file) lives in `Piss_core__Workspace_io` in
   src/lib/.

   Both the backend (validating user-supplied paths, building
   resource_link blocks for ACP) and the browser shell (rendering
   mention dropdowns) depend on this module. *)

(** A workspace-relative mention of a single file. The frontend
    renders these in the `@`-dropdown; the backend hands them to
    the worker which decides whether to attach them as
    `resource_link` blocks on the next prompt. *)
type mention = {
  path : string;
  name : string;
  size : int;
}

(** A workspace file resolved against the actual filesystem. The
    `uri` is a percent-encoded `file://` URL the harness will read;
    `mime_type` is inferred from the extension and may be [None]
    for unknown extensions. *)
type resource = {
  path : string;
  name : string;
  uri : string;
  size : int;
  mime_type : string option;
}

(** Maximum depth of a workspace search from the root. *)
val max_depth : int

(** Maximum number of directory entries the search may visit. The
    search stops when this bound is reached so a hostile workspace
    cannot exhaust the worker's time. *)
val max_visited_entries : int

(** Maximum number of mentions the search returns. *)
val max_results : int

(** Maximum number of bytes the mention response may occupy. *)
val max_response_bytes : int

(** Maximum length of a workspace-relative path in bytes. *)
val max_path_bytes : int

(** Maximum wall-clock seconds a search may take. *)
val max_search_seconds : float

(** Names that the search skips when recursing. *)
val ignored_directory : string -> bool

(** True when [path] is a syntactically valid workspace-relative path.
    No traversal, no NUL, no whitespace control characters, no
    non-printable bytes. The filesystem check that the path actually
    exists happens in `Workspace_io.resolve_resource`. *)
val valid_relative_path : string -> bool

(** True when [child] is [parent] or below [parent] in the filesystem.
    The check is on absolute, realpath-canonicalised paths. *)
val path_within : root:string -> path:string -> bool

(** Case-insensitive substring search. *)
val lowercase_contains : string -> string -> bool

(** Ordering for workspace mentions in the `@`-dropdown: prefix
    matches first, then substring matches, then alphabetical by path. *)
val compare_mentions : string -> mention -> mention -> int

(** Percent-encode [path] as a `file://` URL. *)
val file_uri : string -> string

(** Infer the MIME type of [path] from its extension. Unknown
    extensions return [None]. *)
val mime_type : string -> string option

val mention_to_yojson : mention -> Yojson.Safe.t
val resource_metadata : resource -> Yojson.Safe.t
