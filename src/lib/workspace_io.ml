(* Backend-only workspace file operations. The pure types and
   validators live in `piss.shared.Workspace_files`; this module
   adds the filesystem IO that walks the workspace, validates that
   a path stays inside the workspace root, and produces mention
   search results and resolved resource records. *)

open Piss_shared.Workspace_files

let read_directory_bounded path remaining =
  let directory = Unix.opendir path in
  Fun.protect
    ~finally:(fun () -> Unix.closedir directory)
    (fun () ->
      let rec loop count entries =
        if count >= remaining then (List.sort String.compare entries, count)
        else
          match Unix.readdir directory with
          | name -> loop (count + 1) (name :: entries)
          | exception End_of_file -> (List.sort String.compare entries, count)
      in
      loop 0 [])

let search ~root ~query =
  if String.length query > 200 || String.contains query '\000' then
    Error "file mention query is invalid"
  else
    try
      let root = Unix.realpath root in
      if (Unix.stat root).st_kind <> Unix.S_DIR then
        Error "workspace root is not a directory"
      else
        let deadline = Unix.gettimeofday () +. max_search_seconds in
        let queue = Queue.create () in
        Queue.add ("", root, 0) queue;
        let visited = ref 0 in
        let matches = ref [] in
        while
          !visited < max_visited_entries
          && Unix.gettimeofday () < deadline
          && not (Queue.is_empty queue)
        do
          let relative_directory, absolute_directory, depth =
            Queue.take queue
          in
          let remaining = max_visited_entries - !visited in
          let entries, count =
            read_directory_bounded absolute_directory remaining
          in
          visited := !visited + count;
          List.iter
            (fun name ->
              if name <> "." && name <> ".." && Unix.gettimeofday () < deadline
              then
                let relative =
                  if relative_directory = "" then name
                  else Filename.concat relative_directory name
                in
                if valid_relative_path relative then
                  let absolute = Filename.concat absolute_directory name in
                  try
                    match (Unix.lstat absolute).st_kind with
                    | Unix.S_REG ->
                        if lowercase_contains relative
                             (String.trim query)
                        then
                          let stats = Unix.stat absolute in
                          matches :=
                            { Piss_shared.Workspace_files.path = relative;
                              name;
                              size = stats.st_size }
                            :: !matches
                    | Unix.S_DIR
                      when depth < max_depth
                           && not (ignored_directory name) ->
                        Queue.add (relative, absolute, depth + 1) queue
                    | Unix.S_DIR | Unix.S_CHR | Unix.S_BLK | Unix.S_LNK
                    | Unix.S_FIFO | Unix.S_SOCK ->
                        ()
                  with Unix.Unix_error _ -> ())
            entries
        done;
        let sorted =
          List.sort
            (compare_mentions (String.trim query))
            !matches
        in
        let rec bounded count bytes (mentions : Piss_shared.Workspace_files.mention list)
            (remaining : Piss_shared.Workspace_files.mention list) =
          match remaining with
          | [] -> List.rev mentions
          | _ when count >= max_results -> List.rev mentions
          | mention :: rest ->
              let next_bytes = bytes + String.length mention.path + 64 in
              if next_bytes > max_response_bytes then
                List.rev mentions
              else bounded (count + 1) next_bytes (mention :: mentions) rest
        in
        Ok (bounded 0 2 [] sorted)
    with
    | Unix.Unix_error _ -> Error "workspace file search is unavailable"
    | Sys_error _ -> Error "workspace file search is unavailable"

let resolve_resource ~root ~path =
  if not (valid_relative_path path) then
    Error "resource path is invalid"
  else
    try
      let root = Unix.realpath root in
      let absolute = Filename.concat root path |> Unix.realpath in
      let stats = Unix.stat absolute in
      if not (path_within ~root ~path:absolute) then
        Error "resource path escapes the workspace"
      else if stats.st_kind <> Unix.S_REG then
        Error "resource path is not a regular file"
      else
        Ok
          {
            Piss_shared.Workspace_files.path;
            name = path;
            uri = file_uri absolute;
            size = stats.st_size;
            mime_type = mime_type path;
          }
    with Unix.Unix_error _ -> Error "resource file is unavailable"
