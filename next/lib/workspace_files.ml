type mention = { path : string; name : string; size : int }

type resource = {
  path : string;
  name : string;
  uri : string;
  size : int;
  mime_type : string option;
}

let max_depth = 12
let max_visited_entries = 5000
let max_results = 20
let max_response_bytes = 64 * 1024
let max_path_bytes = 16 * 1024
let max_search_seconds = 0.15

let ignored_directory name =
  (String.length name > 0 && name.[0] = '.')
  || List.mem name [ "node_modules"; "result"; "dist"; "_build"; "vendor" ]

let valid_relative_path path =
  path <> ""
  && String.length path <= max_path_bytes
  && Filename.is_relative path
  && (not (String.contains path '\000'))
  && (not (String.contains path '\n'))
  && (not (String.contains path '\r'))
  && (not (String.contains path '\t'))
  && (not (String.contains path '"'))
  && String.for_all
       (fun character ->
         let code = Char.code character in
         code >= 32 && code <> 127)
       path
  && path |> String.split_on_char '/'
     |> List.for_all (fun part -> part <> "" && part <> "." && part <> "..")

let path_within ~root path =
  String.equal root path
  || String.starts_with
       ~prefix:(if String.ends_with ~suffix:"/" root then root else root ^ "/")
       path

let lowercase_contains value query =
  let value = String.lowercase_ascii value
  and query = String.lowercase_ascii query in
  let value_length = String.length value
  and query_length = String.length query in
  let rec loop index =
    query_length = 0
    || index + query_length <= value_length
       && (String.sub value index query_length = query || loop (index + 1))
  in
  loop 0

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

let compare_mentions query (left : mention) (right : mention) =
  let basename_score (mention : mention) =
    let name = String.lowercase_ascii mention.name
    and query = String.lowercase_ascii query in
    if String.starts_with ~prefix:query name then 0
    else if lowercase_contains name query then 1
    else 2
  in
  match Int.compare (basename_score left) (basename_score right) with
  | 0 -> String.compare left.path right.path
  | value -> value

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
                        if lowercase_contains relative (String.trim query) then
                          let stats = Unix.stat absolute in
                          matches :=
                            { path = relative; name; size = stats.st_size }
                            :: !matches
                    | Unix.S_DIR
                      when depth < max_depth && not (ignored_directory name) ->
                        Queue.add (relative, absolute, depth + 1) queue
                    | Unix.S_DIR | Unix.S_CHR | Unix.S_BLK | Unix.S_LNK
                    | Unix.S_FIFO | Unix.S_SOCK ->
                        ()
                  with Unix.Unix_error _ -> ())
            entries
        done;
        let sorted =
          List.sort (compare_mentions (String.trim query)) !matches
        in
        let rec bounded count bytes (mentions : mention list)
            (remaining : mention list) =
          match remaining with
          | [] -> List.rev mentions
          | _ when count >= max_results -> List.rev mentions
          | mention :: rest ->
              let next_bytes = bytes + String.length mention.path + 64 in
              if next_bytes > max_response_bytes then List.rev mentions
              else bounded (count + 1) next_bytes (mention :: mentions) rest
        in
        Ok (bounded 0 2 [] sorted)
    with
    | Unix.Unix_error _ -> Error "workspace file search is unavailable"
    | Sys_error _ -> Error "workspace file search is unavailable"

let hex = "0123456789ABCDEF"

let file_uri path =
  let buffer = Buffer.create (String.length path + 16) in
  Buffer.add_string buffer "file://";
  String.iter
    (fun character ->
      match character with
      | 'a' .. 'z' | 'A' .. 'Z' | '0' .. '9' | '-' | '.' | '_' | '~' | '/' ->
          Buffer.add_char buffer character
      | value ->
          let code = Char.code value in
          Buffer.add_char buffer '%';
          Buffer.add_char buffer hex.[code lsr 4];
          Buffer.add_char buffer hex.[code land 0x0f])
    path;
  Buffer.contents buffer

let mime_type path =
  match String.lowercase_ascii (Filename.extension path) with
  | ".ml" | ".mli" -> Some "text/x-ocaml"
  | ".re" | ".rei" -> Some "text/x-reason"
  | ".js" | ".mjs" | ".cjs" -> Some "text/javascript"
  | ".ts" | ".tsx" -> Some "text/typescript"
  | ".json" -> Some "application/json"
  | ".md" -> Some "text/markdown"
  | ".css" -> Some "text/css"
  | ".html" -> Some "text/html"
  | ".sh" -> Some "text/x-shellscript"
  | ".nix" -> Some "text/x-nix"
  | ".txt" -> Some "text/plain"
  | _ -> None

let resolve_resource ~root path =
  if not (valid_relative_path path) then Error "resource path is invalid"
  else
    try
      let root = Unix.realpath root in
      let absolute = Filename.concat root path |> Unix.realpath in
      let stats = Unix.stat absolute in
      if not (path_within ~root absolute) then
        Error "resource path escapes the workspace"
      else if stats.st_kind <> Unix.S_REG then
        Error "resource path is not a regular file"
      else
        Ok
          {
            path;
            name = path;
            uri = file_uri absolute;
            size = stats.st_size;
            mime_type = mime_type path;
          }
    with Unix.Unix_error _ -> Error "resource file is unavailable"

let mention_to_yojson (mention : mention) =
  `Assoc
    [
      ("path", `String mention.path);
      ("name", `String mention.name);
      ("kind", `String "file");
      ("size", `Int mention.size);
    ]
