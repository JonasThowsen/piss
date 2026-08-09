(* Workspace directory discovery and naming. *)

let path_within ~root path =
  String.equal root path
  ||
  let prefix = if String.ends_with ~suffix:"/" root then root else root ^ "/" in
  String.starts_with ~prefix path

let canonical_directory path =
  try
    let canonical = Unix.realpath path in
    if (Unix.stat canonical).st_kind = Unix.S_DIR then Some canonical else None
  with Unix.Unix_error _ -> None

let workspace_name path =
  let name = String.trim (Filename.basename path) in
  if name <> "" && String.length name <= 120 then name else "Workspace"

let workspace_id_for_path path =
  "workspace-" ^ Digest.to_hex (Digest.string path)

let ignored_directory name =
  (String.length name > 0 && name.[0] = '.')
  || List.mem name [ "node_modules"; "result"; "dist"; "_build" ]

let search_workspace_directories roots query =
  let terms =
    String.lowercase_ascii (String.trim query)
    |> String.split_on_char ' '
    |> List.filter (fun value -> value <> "")
  in
  let contains value term =
    let value_length = String.length value
    and term_length = String.length term in
    let rec loop index =
      if index + term_length > value_length then false
      else if String.sub value index term_length = term then true
      else loop (index + 1)
    in
    term_length = 0 || loop 0
  in
  let matches path =
    let value = String.lowercase_ascii path in
    List.for_all (contains value) terms
  in
  let max_depth = if terms = [] then 1 else 6 in
  let seen = Hashtbl.create 512 in
  let results = ref [] in
  let queue = Queue.create () in
  List.iter
    (fun path ->
      match canonical_directory path with
      | Some root -> Queue.add (root, root, 0) queue
      | None -> ())
    roots;
  let visited = ref 0 in
  while !visited < 5000 && not (Queue.is_empty queue) do
    let root, path, depth = Queue.take queue in
    incr visited;
    match canonical_directory path with
    | None -> ()
    | Some canonical
      when (not (path_within ~root canonical)) || Hashtbl.mem seen canonical ->
        ()
    | Some canonical -> (
        Hashtbl.add seen canonical ();
        if matches canonical && List.length !results < 60 then
          results := canonical :: !results;
        if depth < max_depth then
          try
            let entries = Sys.readdir canonical in
            Array.sort String.compare entries;
            entries
            |> Array.iter (fun name ->
                if not (ignored_directory name) then
                  let child = Filename.concat canonical name in
                  try
                    if (Unix.lstat child).st_kind = Unix.S_DIR then
                      Queue.add (root, child, depth + 1) queue
                  with Unix.Unix_error _ -> ())
          with Sys_error _ -> ())
  done;
  List.rev !results
