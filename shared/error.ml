type t =
  | Not_found of { resource : string; id : string }
  | Forbidden of { reason : string }
  | Conflict of { reason : string }
  | Upstream_unavailable of { message : string }
  | Validation of { field : string; reason : string }
  | Internal of { message : string }

let to_string = function
  | Not_found { resource; id = "" } -> resource ^ " not found"
  | Not_found { resource; id } -> resource ^ " not found: " ^ id
  | Forbidden { reason } | Conflict { reason } | Validation { reason; _ } ->
      reason
  | Upstream_unavailable { message } | Internal { message } -> message

let to_yojson error =
  let fields =
    match error with
    | Not_found { resource; id } ->
        [
          ("kind", `String "Not_found");
          ("resource", `String resource);
          ("id", `String id);
        ]
    | Forbidden { reason } ->
        [ ("kind", `String "Forbidden"); ("reason", `String reason) ]
    | Conflict { reason } ->
        [ ("kind", `String "Conflict"); ("reason", `String reason) ]
    | Upstream_unavailable { message } ->
        [
          ("kind", `String "Upstream_unavailable"); ("message", `String message);
        ]
    | Validation { field; reason } ->
        [
          ("kind", `String "Validation");
          ("field", `String field);
          ("reason", `String reason);
        ]
    | Internal { message } ->
        [ ("kind", `String "Internal"); ("message", `String message) ]
  in
  `Assoc fields

let string_field name fields =
  match List.assoc_opt name fields with
  | Some (`String value) -> Ok value
  | Some _ -> Error (name ^ " must be a string")
  | None -> Error (name ^ " is required")

let ( let* ) = Result.bind

let of_yojson = function
  | `Assoc fields ->
      let* kind = string_field "kind" fields in
      begin match kind with
      | "Not_found" ->
          let* resource = string_field "resource" fields in
          let* id = string_field "id" fields in
          Ok (Not_found { resource; id })
      | "Forbidden" ->
          let* reason = string_field "reason" fields in
          Ok (Forbidden { reason })
      | "Conflict" ->
          let* reason = string_field "reason" fields in
          Ok (Conflict { reason })
      | "Upstream_unavailable" ->
          let* message = string_field "message" fields in
          Ok (Upstream_unavailable { message })
      | "Validation" ->
          let* field = string_field "field" fields in
          let* reason = string_field "reason" fields in
          Ok (Validation { field; reason })
      | "Internal" ->
          let* message = string_field "message" fields in
          Ok (Internal { message })
      | value -> Error ("unknown error kind: " ^ value)
      end
  | _ -> Error "error must be an object"
