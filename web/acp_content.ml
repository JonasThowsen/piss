open! Core

type artifact =
  | Diff of { path : string; before : string; after : string }
  | Terminal of { terminal_id : string; text : string option }
  | Image of Image_attachment.t
  | Resource of { uri : string; name : string option; text : string option }
  | Location of { path : string; line : int option; text : string option }

let ( let* ) result f = Result.bind result ~f
let error path message = Error (path ^ " " ^ message)

let assoc path = function
  | `Assoc fields -> Ok fields
  | _ -> error path "must be an object"

let list path = function
  | `List values -> Ok values
  | _ -> error path "must be an array"

let string path = function
  | `String value -> Ok value
  | _ -> error path "must be a string"

let nonempty_string path json =
  let* value = string path json in
  if String.is_empty value then error path "must not be empty" else Ok value

let positive_int path = function
  | `Int value when value > 0 -> Ok value
  | `Intlit value -> (
      match Int.of_string_opt value with
      | Some value when value > 0 -> Ok value
      | _ -> error path "must be a positive integer")
  | _ -> error path "must be a positive integer"

let field fields path name =
  match List.Assoc.find fields ~equal:String.equal name with
  | Some value -> Ok value
  | None -> error (path ^ "." ^ name) "is required"

let field_as fields path name decode =
  let* value = field fields path name in
  decode (path ^ "." ^ name) value

let optional_field fields path name decode =
  match List.Assoc.find fields ~equal:String.equal name with
  | None | Some `Null -> Ok None
  | Some value -> Result.map (decode (path ^ "." ^ name) value) ~f:Option.some

let decode_diff path fields =
  let* path_value = field_as fields path "path" nonempty_string in
  let* before = optional_field fields path "oldText" string in
  let* after = field_as fields path "newText" string in
  Ok
    (Diff { path = path_value; before = Option.value before ~default:""; after })

let decode_terminal path fields =
  let* terminal_id = field_as fields path "terminalId" nonempty_string in
  let* text = optional_field fields path "text" string in
  Ok (Terminal { terminal_id; text })

let decode_image path fields =
  let* mime_type = field_as fields path "mimeType" nonempty_string in
  let* data = field_as fields path "data" nonempty_string in
  Image_attachment.of_base64 ~name:"Agent-produced image" ~mime_type data
  |> Result.bind ~f:(fun image ->
      if Image_attachment.size image > Image_attachment.max_total_bytes then
        Error "Image exceeds the 10 MiB limit"
      else Ok (Image image))
  |> Result.map_error ~f:(fun message -> path ^ " " ^ message)

let decode_resource path fields =
  let* resource = field_as fields path "resource" assoc in
  let resource_path = path ^ ".resource" in
  let* uri = field_as resource resource_path "uri" nonempty_string in
  let* name = optional_field resource resource_path "name" string in
  let* text = optional_field resource resource_path "text" string in
  Ok (Resource { uri; name; text })

let rec content_part path json =
  let* fields = assoc path json in
  let* type_ = field_as fields path "type" nonempty_string in
  match type_ with
  | "text" ->
      let* value = field_as fields path "text" string in
      Ok (Some value, None)
  | "content" ->
      let* content = field fields path "content" in
      content_part (path ^ ".content") content
  | "diff" ->
      Result.map (decode_diff path fields) ~f:(fun item -> (None, Some item))
  | "terminal" ->
      Result.map (decode_terminal path fields) ~f:(fun item ->
          (None, Some item))
  | "image" ->
      Result.map (decode_image path fields) ~f:(fun item -> (None, Some item))
  | "resource" ->
      Result.map (decode_resource path fields) ~f:(fun item ->
          (None, Some item))
  | _ -> Ok (None, None)

let tool_content ~path json =
  let* contents = list path json in
  let* parts =
    contents
    |> List.mapi ~f:(fun index content ->
        content_part (Printf.sprintf "%s[%d]" path index) content)
    |> Result.all
  in
  let output = List.filter_map parts ~f:fst |> String.concat ~sep:"\n" in
  Ok (output, List.filter_map parts ~f:snd)

let decode_location path json =
  let* fields = assoc path json in
  let* path_value = field_as fields path "path" nonempty_string in
  let* line = optional_field fields path "line" positive_int in
  let* text = optional_field fields path "text" string in
  Ok (Location { path = path_value; line; text })

let locations ~path fields =
  match List.Assoc.find fields ~equal:String.equal "locations" with
  | None -> Ok []
  | Some json ->
      let* values = list (path ^ ".locations") json in
      values
      |> List.mapi ~f:(fun index value ->
          decode_location (Printf.sprintf "%s.locations[%d]" path index) value)
      |> Result.all

let equal left right =
  match (left, right) with
  | Diff left, Diff right ->
      String.equal left.path right.path
      && String.equal left.before right.before
      && String.equal left.after right.after
  | Terminal left, Terminal right ->
      String.equal left.terminal_id right.terminal_id
      && Option.equal String.equal left.text right.text
  | Image left, Image right ->
      String.equal
        (Image_attachment.mime_type left)
        (Image_attachment.mime_type right)
      && String.equal (Image_attachment.data left) (Image_attachment.data right)
  | Resource left, Resource right ->
      String.equal left.uri right.uri
      && Option.equal String.equal left.name right.name
      && Option.equal String.equal left.text right.text
  | Location left, Location right ->
      String.equal left.path right.path
      && Option.equal Int.equal left.line right.line
      && Option.equal String.equal left.text right.text
  | Diff _, _ | Terminal _, _ | Image _, _ | Resource _, _ | Location _, _ ->
      false

let copy_text = function
  | Diff { path; before; after } ->
      String.concat ~sep:"\n"
        [ "diff: " ^ path; "before:"; before; "after:"; after ]
  | Terminal { terminal_id; text } ->
      "terminal: " ^ terminal_id
      ^ Option.value_map text ~default:"" ~f:(fun value -> "\n" ^ value)
  | Image image -> "image: " ^ Image_attachment.mime_type image
  | Resource { uri; name; text } ->
      List.filter_opt [ Some ("resource: " ^ uri); name; text ]
      |> String.concat ~sep:"\n"
  | Location { path; line; text } ->
      "location: " ^ path
      ^ Option.value_map line ~default:"" ~f:(fun value ->
          ":" ^ Int.to_string value)
      ^ Option.value_map text ~default:"" ~f:(fun value -> "\n" ^ value)
