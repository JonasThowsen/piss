open! Core

type resource = { path : string; name : string; kind : string; size : int }
type active = { query : string; start : int; stop : int }
type insertion = { text : string; cursor : int }
type availability = Loading | Ready of resource list | Failed of string

type model =
  | Closed
  | Open of {
      active : active;
      generation : int;
      availability : availability;
      selected : int;
    }

let max_query_length = 200
let boundary text index = index = 0 || Char.is_whitespace text.[index - 1]

let active_at_cursor ~text ~cursor =
  let length = String.length text in
  if cursor < 0 || cursor > length then None
  else
    let line_start =
      match
        String.rfindi (String.prefix text cursor) ~f:(fun _ char ->
            Char.equal char '\n')
      with
      | Some index -> index + 1
      | None -> 0
    in
    let rec find_at index =
      if index < line_start then None
      else if Char.equal text.[index] '@' then Some index
      else find_at (index - 1)
    in
    match find_at (cursor - 1) with
    | None -> None
    | Some start when not (boundary text start) -> None
    | Some start ->
        let body_start = start + 1 in
        let quoted = body_start < cursor && Char.equal text.[body_start] '"' in
        let query_start = if quoted then body_start + 1 else body_start in
        let query_length = cursor - query_start in
        let query = String.sub text ~pos:query_start ~len:query_length in
        let valid =
          query_length <= max_query_length
          &&
          if quoted then not (String.contains query '"')
          else not (String.exists query ~f:Char.is_whitespace)
        in
        if valid then Some { query; start; stop = cursor } else None

let clamp value ~low ~high = Int.max low (Int.min high value)

let insert_trigger ~text ~selection_start ~selection_end =
  let length = String.length text in
  let selection_start = clamp selection_start ~low:0 ~high:length in
  let selection_end = clamp selection_end ~low:selection_start ~high:length in
  let separator =
    if
      selection_start > 0 && not (Char.is_whitespace text.[selection_start - 1])
    then " "
    else ""
  in
  let inserted = separator ^ "@" in
  {
    text =
      String.prefix text selection_start
      ^ inserted
      ^ String.drop_prefix text selection_end;
    cursor = selection_start + String.length inserted;
  }

let token path =
  if String.exists path ~f:Char.is_whitespace then "@\"" ^ path ^ "\""
  else "@" ^ path

let insert_resource ~text ~active ~path =
  let length = String.length text in
  if
    active.start < 0 || active.stop < active.start || active.stop > length
    || not (Char.equal text.[active.start] '@')
  then None
  else
    let token = token path in
    Some
      {
        text =
          String.prefix text active.start
          ^ token
          ^ String.drop_prefix text active.stop;
        cursor = active.start + String.length token;
      }

let add_resource resources resource =
  if
    List.exists resources ~f:(fun current ->
        String.equal current.path resource.path)
  then resources
  else resources @ [ resource ]

let token_present text path =
  let needle = token path in
  let needle_length = String.length needle in
  let text_length = String.length text in
  let rec search position =
    match String.substr_index text ~pos:position ~pattern:needle with
    | None -> false
    | Some start ->
        let stop = start + needle_length in
        let starts_at_boundary = boundary text start in
        let ends_at_boundary =
          stop = text_length || Char.is_whitespace text.[stop]
        in
        if starts_at_boundary && ends_at_boundary then true
        else search (start + 1)
  in
  search 0

let reconcile ~text resources =
  List.fold resources ~init:(String.Set.empty, [])
    ~f:(fun (seen, kept) resource ->
      if Set.mem seen resource.path || not (token_present text resource.path)
      then (seen, kept)
      else (Set.add seen resource.path, resource :: kept))
  |> snd |> List.rev

let error path message = Error (path ^ " " ^ message)

let field fields path name =
  match List.Assoc.find fields ~equal:String.equal name with
  | Some value -> Ok value
  | None -> error (path ^ "." ^ name) "is required"

let string_field fields path name =
  Result.bind (field fields path name) ~f:(function
    | `String value -> Ok value
    | _ -> error (path ^ "." ^ name) "must be a string")

let int_field fields path name =
  Result.bind (field fields path name) ~f:(function
    | `Int value -> Ok value
    | `Intlit value -> (
        match Int.of_string_opt value with
        | Some value -> Ok value
        | None -> error (path ^ "." ^ name) "must be an integer")
    | _ -> error (path ^ "." ^ name) "must be an integer")

let decode_resource index = function
  | `Assoc fields ->
      let path_label = Printf.sprintf "file mentions[%d]" index in
      Result.bind (string_field fields path_label "path") ~f:(fun path ->
          Result.bind (string_field fields path_label "name") ~f:(fun name ->
              Result.bind (string_field fields path_label "kind")
                ~f:(fun kind ->
                  Result.bind (int_field fields path_label "size")
                    ~f:(fun size ->
                      if String.is_empty path then
                        error (path_label ^ ".path") "must not be empty"
                      else if String.is_empty name then
                        error (path_label ^ ".name") "must not be empty"
                      else if not (String.equal kind "file") then
                        error (path_label ^ ".kind") "must be file"
                      else if size < 0 then
                        error (path_label ^ ".size") "must not be negative"
                      else Ok { path; name; kind; size }))))
  | _ -> error (Printf.sprintf "file mentions[%d]" index) "must be an object"

let decode_response body =
  match Result.try_with (fun () -> Yojson.Safe.from_string body) with
  | Error exn -> Error ("response is not valid JSON: " ^ Exn.to_string exn)
  | Ok (`List resources) ->
      resources |> List.mapi ~f:decode_resource |> Result.all
  | Ok _ -> Error "response must be a JSON array"

let loading active ~generation =
  Open { active; generation; availability = Loading; selected = 0 }

let compare_resource query left right =
  let query = String.lowercase query in
  let score resource =
    let name = String.lowercase resource.name in
    if String.is_prefix name ~prefix:query then 0
    else if String.is_substring name ~substring:query then 1
    else 2
  in
  match Int.compare (score left) (score right) with
  | 0 -> (
      match String.compare left.name right.name with
      | 0 -> String.compare left.path right.path
      | value -> value)
  | value -> value

let resolve model ~generation resources =
  match model with
  | Open current when current.generation = generation ->
      let resources =
        List.sort resources ~compare:(compare_resource current.active.query)
      in
      Open { current with availability = Ready resources; selected = 0 }
  | _ -> model

let fail model ~generation message =
  match model with
  | Open current when current.generation = generation ->
      Open { current with availability = Failed message; selected = 0 }
  | _ -> model

let move model direction =
  match model with
  | Open ({ availability = Ready resources; selected; _ } as current) ->
      let count = List.length resources in
      if count = 0 then model
      else
        let selected = (selected + direction + count) mod count in
        Open { current with selected }
  | _ -> model

let select_index model selected =
  match model with
  | Open ({ availability = Ready resources; _ } as current)
    when selected >= 0 && selected < List.length resources ->
      Open { current with selected }
  | _ -> model

let selected_resource = function
  | Open { availability = Ready resources; selected; _ } ->
      List.nth resources selected
  | _ -> None
