open! Core

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

let field fields path name =
  match List.Assoc.find fields ~equal:String.equal name with
  | Some value -> Ok value
  | None -> error (path ^ "." ^ name) "is required"

let field_string fields path name =
  let* value = field fields path name in
  string (path ^ "." ^ name) value

let artifact path label fields name =
  match List.Assoc.find fields ~equal:String.equal name with
  | Some (`String value) -> Ok (Some (label ^ value))
  | Some _ -> error (path ^ "." ^ name) "must be a string"
  | None -> Ok None

let rec content_part path json =
  let* fields = assoc path json in
  let* type_ = field_string fields path "type" in
  match type_ with
  | "text" ->
      let* value = field_string fields path "text" in
      Ok (Some value, None)
  | "content" ->
      let* content = field fields path "content" in
      content_part (path ^ ".content") content
  | "diff" ->
      Result.map (artifact path "diff: " fields "path") ~f:(fun value ->
          (None, value))
  | "terminal" ->
      Result.map (artifact path "terminal: " fields "terminalId")
        ~f:(fun value -> (None, value))
  | "image" ->
      Result.map (artifact path "image: " fields "mimeType") ~f:(fun value ->
          (None, value))
  | "resource" -> (
      match List.Assoc.find fields ~equal:String.equal "resource" with
      | Some (`Assoc resource) ->
          Result.map (artifact path "resource: " resource "uri")
            ~f:(fun value -> (None, value))
      | Some _ -> error (path ^ ".resource") "must be an object"
      | None -> Ok (None, None))
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

let locations ~path fields =
  match List.Assoc.find fields ~equal:String.equal "locations" with
  | None -> Ok []
  | Some json ->
      let* values = list (path ^ ".locations") json in
      values
      |> List.mapi ~f:(fun index value ->
          let item_path = Printf.sprintf "%s.locations[%d]" path index in
          let* location = assoc item_path value in
          let* value = field_string location item_path "path" in
          Ok ("location: " ^ value))
      |> Result.all
