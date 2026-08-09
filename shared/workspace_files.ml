(* Pure parts of the workspace file handling. The IO code (walking
   the filesystem, resolving paths, etc.) lives in src/lib/
   workspace_files.ml and uses the types declared here.

   The frontend depends on this module to render file mentions,
   resolve the canonical workspace-relative path of a selected
   mention, and display the size/mime-type metadata.

   The backend depends on this module to validate user-supplied
   paths and to construct resource_link blocks for the ACP wire
   protocol. *)

type mention = {
  path : string;
  name : string;
  size : int;
}

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

let path_within ~root ~path =
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

let mention_to_yojson (mention : mention) =
  `Assoc
    [
      ("path", `String mention.path);
      ("name", `String mention.name);
      ("kind", `String "file");
      ("size", `Int mention.size);
    ]

let resource_metadata (resource : resource) =
  `Assoc
    ([
       ("path", `String resource.path);
       ("name", `String resource.name);
       ("size", `Int resource.size);
     ]
    @
    match resource.mime_type with
    | Some value -> [ ("mimeType", `String value) ]
    | None -> [])
