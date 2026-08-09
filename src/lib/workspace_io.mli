(* Backend-only workspace file operations. The pure types and
   validators live in [Piss_shared.Workspace_files]; this module
   adds the filesystem IO that walks the workspace, validates that
   a path stays inside the workspace root, and produces mention
   search results and resolved resource records.

   Every function takes an absolute, canonicalised workspace [root]
   and a workspace-relative [path] (for [resolve_resource]) or
   search query (for [search]). The caller is responsible for the
   boundary check on [root]; [resolve_resource] enforces the
   boundary on [path]. *)

(** Walk [root] looking for files whose workspace-relative path
    contains [query] (case-insensitive substring match). Returns at
    most [max_results] mentions, sorted by basename relevance.
    Respects [max_search_seconds] as a wall-clock budget and
    [max_visited_entries] as a directory-visit budget. *)
val search :
  root:string ->
  query:string ->
  (Piss_shared.Workspace_files.mention list, string) result

(** Resolve a workspace-relative [path] against an absolute [root].
    Returns a [Piss_shared.Workspace_files.resource] with the
    canonical workspace-relative path, the percent-encoded
    `file://` uri, the byte size from [Unix.stat], and the MIME
    type inferred from the extension. Returns [Error] when:

    * the path is not syntactically a workspace-relative path;
    * the path escapes the workspace root after realpath
      canonicalisation (symlinks are followed);
    * the path is not a regular file. *)
val resolve_resource :
  root:string ->
  path:string ->
  (Piss_shared.Workspace_files.resource, string) result
