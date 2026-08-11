open! Core

type file = {
  path : string;
  previous_path : string option;
  index_status : string;
  worktree_status : string;
  patch : string;
  truncated : bool;
  binary : bool;
  role : string;
  reason : string;
  journey_index : int option;
}

type t = {
  generated_at : float;
  files : file list;
  total_files : int;
  accounted_files : int;
  highlighted_files : int;
  truncated : bool;
}

type request = { session_id : string; generation : int }

type load_state =
  | Dormant
  | Loading of request
  | Loaded of request * t
  | Failed of request * string

type load_action =
  | Start of request
  | Succeeded of request * t
  | Rejected of request * string
  | Deactivate

let error path expected = Error (path ^ " " ^ expected)

let field fields path name =
  match List.Assoc.find fields ~equal:String.equal name with
  | Some value -> Ok value
  | None -> error (path ^ "." ^ name) "is required"

let string path = function
  | `String value -> Ok value
  | _ -> error path "must be a string"

let bool path = function
  | `Bool value -> Ok value
  | _ -> error path "must be a boolean"

let number path = function
  | `Int value -> Ok (Float.of_int value)
  | `Intlit value -> (
      match Float.of_string_opt value with
      | Some value when Float.is_finite value -> Ok value
      | _ -> error path "must be a finite number")
  | `Float value when Float.is_finite value -> Ok value
  | _ -> error path "must be a finite number"

let non_negative_int path = function
  | `Int value when value >= 0 -> Ok value
  | `Intlit value -> (
      match Int.of_string_opt value with
      | Some value when value >= 0 -> Ok value
      | _ -> error path "must be a non-negative integer")
  | _ -> error path "must be a non-negative integer"

let nullable_string path = function
  | `Null -> Ok None
  | `String value -> Ok (Some value)
  | _ -> error path "must be null or a string"

let positive_nullable_int path = function
  | `Null -> Ok None
  | `Int value when value > 0 -> Ok (Some value)
  | `Intlit value -> (
      match Int.of_string_opt value with
      | Some value when value > 0 -> Ok (Some value)
      | _ -> error path "must be null or a positive integer")
  | _ -> error path "must be null or a positive integer"

let list path = function
  | `List values -> Ok values
  | _ -> error path "must be an array"

let bind_field fields path name decode f =
  Result.bind (field fields path name) ~f:(fun value ->
      Result.bind (decode (path ^ "." ^ name) value) ~f)

let status path value =
  Result.bind (string path value) ~f:(fun value ->
      if String.length value = 1 then Ok value
      else error path "must be one character")

let decode_file index = function
  | `Assoc fields ->
      let path = Printf.sprintf "audit.files[%d]" index in
      bind_field fields path "path" string (fun file_path ->
          bind_field fields path "previousPath" nullable_string
            (fun previous_path ->
              bind_field fields path "indexStatus" status (fun index_status ->
                  bind_field fields path "worktreeStatus" status
                    (fun worktree_status ->
                      bind_field fields path "patch" string (fun patch ->
                          bind_field fields path "truncated" bool
                            (fun truncated ->
                              bind_field fields path "binary" bool
                                (fun binary ->
                                  bind_field fields path "role" string
                                    (fun role ->
                                      bind_field fields path "reason" string
                                        (fun reason ->
                                          bind_field fields path "journeyIndex"
                                            positive_nullable_int
                                            (fun journey_index ->
                                              if String.is_empty file_path then
                                                error (path ^ ".path")
                                                  "must not be empty"
                                              else if String.is_empty role then
                                                error (path ^ ".role")
                                                  "must not be empty"
                                              else if String.is_empty reason
                                              then
                                                error (path ^ ".reason")
                                                  "must not be empty"
                                              else
                                                Ok
                                                  {
                                                    path = file_path;
                                                    previous_path;
                                                    index_status;
                                                    worktree_status;
                                                    patch;
                                                    truncated;
                                                    binary;
                                                    role;
                                                    reason;
                                                    journey_index;
                                                  }))))))))))
  | _ -> error (Printf.sprintf "audit.files[%d]" index) "must be an object"

let decode_json = function
  | `Assoc root -> (
      match List.Assoc.find root ~equal:String.equal "audit" with
      | Some (`Assoc fields) ->
          bind_field fields "audit" "generatedAt" number (fun generated_at ->
              bind_field fields "audit" "totalFiles" non_negative_int
                (fun total_files ->
                  bind_field fields "audit" "accountedFiles" non_negative_int
                    (fun accounted_files ->
                      bind_field fields "audit" "highlightedFiles"
                        non_negative_int (fun highlighted_files ->
                          bind_field fields "audit" "truncated" bool
                            (fun truncated ->
                              bind_field fields "audit" "files" list
                                (fun files_json ->
                                  Result.bind
                                    (files_json |> List.mapi ~f:decode_file
                                   |> Result.all)
                                    ~f:(fun files ->
                                      let actual_accounted =
                                        List.length files
                                      in
                                      let indices =
                                        List.filter_map files ~f:(fun file ->
                                            file.journey_index)
                                      in
                                      let actual_highlighted =
                                        List.length indices
                                      in
                                      let unique_indices =
                                        List.dedup_and_sort indices
                                          ~compare:Int.compare
                                      in
                                      if accounted_files <> actual_accounted
                                      then
                                        error "audit.accountedFiles"
                                          "must equal files.length"
                                      else if total_files < accounted_files then
                                        error "audit.totalFiles"
                                          "must be at least accountedFiles"
                                      else if
                                        highlighted_files <> actual_highlighted
                                      then
                                        error "audit.highlightedFiles"
                                          "must match journeyIndex entries"
                                      else if
                                        List.length unique_indices
                                        <> actual_highlighted
                                        || not
                                             (List.for_alli unique_indices
                                                ~f:(fun index value ->
                                                  value = index + 1))
                                      then
                                        error "audit.files[].journeyIndex"
                                          "must be unique and contiguous from 1"
                                      else
                                        Ok
                                          {
                                            generated_at;
                                            files;
                                            total_files;
                                            accounted_files;
                                            highlighted_files;
                                            truncated;
                                          })))))))
      | Some _ -> error "audit" "must be an object"
      | None -> error "audit" "is required")
  | _ -> error "response" "must be an object"

let decode body =
  match Result.try_with (fun () -> Yojson.Safe.from_string body) with
  | Error exn -> Error ("response is not valid JSON: " ^ Exn.to_string exn)
  | Ok json -> decode_json json

let journey audit =
  List.filter_map audit.files ~f:(fun file ->
      Option.map file.journey_index ~f:(fun index -> (index, file)))
  |> List.sort ~compare:(fun (left, _) (right, _) -> Int.compare left right)
  |> List.map ~f:snd

let same_request left right =
  String.equal left.session_id right.session_id
  && Int.equal left.generation right.generation

let apply_load _ state = function
  | Start request -> Loading request
  | Succeeded (request, audit) -> (
      match state with
      | Loading current when same_request current request ->
          Loaded (request, audit)
      | Dormant | Loading _ | Loaded _ | Failed _ -> state)
  | Rejected (request, message) -> (
      match state with
      | Loading current when same_request current request ->
          Failed (request, message)
      | Dormant | Loading _ | Loaded _ | Failed _ -> state)
  | Deactivate -> Dormant

let snapshot_for state ~session_id =
  match state with
  | Loaded (request, audit) when String.equal request.session_id session_id ->
      Some audit
  | Dormant | Loading _ | Loaded _ | Failed _ -> None
