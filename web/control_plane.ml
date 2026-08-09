open! Core

module Session = struct
  type harness = Pi | Opencode | Mock | Other of string

  type status = Runtime_domain.status =
    | Starting
    | Idle
    | Running
    | Requires_action
    | Stopped
    | Failed
    | Offline
    | Archived

  type runtime = Runtime_domain.t

  type t = {
    id : string;
    title : string;
    harness : harness;
    workspace_id : string;
    created_at : float;
    archived_at : float option;
    status : status;
    runtime : runtime option;
  }

  let harness_to_string = function
    | Pi -> "pi"
    | Opencode -> "opencode"
    | Mock -> "mock"
    | Other value -> value

  let status_to_string = Runtime_domain.status_to_string
end

let error path expected = Error (path ^ " " ^ expected)

let field fields path name =
  match List.Assoc.find fields ~equal:String.equal name with
  | Some value -> Ok value
  | None -> error (path ^ "." ^ name) "is required"

let string path = function
  | `String value -> Ok value
  | _ -> error path "must be a string"

let number path = function
  | `Int value -> Ok (Float.of_int value)
  | `Intlit value -> (
      match Float.of_string_opt value with
      | Some value when Float.is_finite value -> Ok value
      | _ -> error path "must be a finite number")
  | `Float value when Float.is_finite value -> Ok value
  | _ -> error path "must be a finite number"

let nullable decode path = function
  | `Null -> Ok None
  | value -> Result.map (decode path value) ~f:Option.some

let harness path value =
  match value with
  | `String "pi" -> Ok Session.Pi
  | `String "opencode" -> Ok Session.Opencode
  | `String "mock" -> Ok Session.Mock
  | `String "" -> error path "must not be empty"
  | `String value -> Ok (Session.Other value)
  | _ -> error path "must be a string"

let status path value =
  match value with
  | `String "starting" -> Ok Session.Starting
  | `String "idle" -> Ok Session.Idle
  | `String "running" -> Ok Session.Running
  | `String "requires_action" -> Ok Session.Requires_action
  | `String "stopped" -> Ok Session.Stopped
  | `String "failed" -> Ok Session.Failed
  | `String "offline" -> Ok Session.Offline
  | `String "archived" -> Ok Session.Archived
  | `String value -> error path ("has unsupported value " ^ value)
  | _ -> error path "must be a string"

let bind_field fields path name decode f =
  Result.bind (field fields path name) ~f:(fun value ->
      Result.bind (decode (path ^ "." ^ name) value) ~f)

let decode_runtime fields path session_id =
  Runtime_domain.decode_json ~path ~expected_session:session_id (`Assoc fields)

let decode_session index = function
  | `Assoc fields ->
      let path = Printf.sprintf "sessions[%d]" index in
      bind_field fields path "id" string (fun id ->
          bind_field fields path "title" string (fun title ->
              bind_field fields path "harness" harness (fun harness ->
                  bind_field fields path "workspaceId" string
                    (fun workspace_id ->
                      bind_field fields path "createdAt" number
                        (fun created_at ->
                          bind_field fields path "archivedAt" (nullable number)
                            (fun archived_at ->
                              bind_field fields path "status" status
                                (fun runtime_status ->
                                  let finish runtime =
                                    Ok
                                      {
                                        Session.id;
                                        title;
                                        harness;
                                        workspace_id;
                                        created_at;
                                        archived_at;
                                        status = runtime_status;
                                        runtime;
                                      }
                                  in
                                  match runtime_status with
                                  | Session.Offline | Session.Archived ->
                                      finish None
                                  | _ ->
                                      Result.bind
                                        (decode_runtime fields path id)
                                        ~f:(fun runtime ->
                                          if
                                            phys_equal runtime.status
                                              runtime_status
                                          then finish (Some runtime)
                                          else
                                            error (path ^ ".status")
                                              "must match runtime status"))))))))
  | _ -> error (Printf.sprintf "sessions[%d]" index) "must be an object"

let decode_sessions body =
  match Result.try_with (fun () -> Yojson.Safe.from_string body) with
  | Error exn -> Error ("response is not valid JSON: " ^ Exn.to_string exn)
  | Ok (`List sessions) -> sessions |> List.mapi ~f:decode_session |> Result.all
  | Ok _ -> Error "response must be a JSON array"

let decode_archived_sessions body =
  Result.bind (decode_sessions body) ~f:(fun sessions ->
      match
        List.findi sessions ~f:(fun _ (session : Session.t) ->
            (not (phys_equal session.status Session.Archived))
            || Option.is_none session.archived_at)
      with
      | None -> Ok sessions
      | Some (index, _) ->
          error
            (Printf.sprintf "sessions[%d]" index)
            "must be an archived session")

let decode_created_session_id body =
  match Result.try_with (fun () -> Yojson.Safe.from_string body) with
  | Error exn -> Error ("response is not valid JSON: " ^ Exn.to_string exn)
  | Ok (`Assoc fields) ->
      bind_field fields "session" "id" string (fun id ->
          bind_field fields "session" "title" string (fun title ->
              bind_field fields "session" "harness" harness (fun _ ->
                  bind_field fields "session" "workspaceId" string (fun _ ->
                      bind_field fields "session" "createdAt" number (fun _ ->
                          bind_field fields "session" "archivedAt"
                            (nullable number) (fun archived_at ->
                              if String.is_empty (String.strip title) then
                                error "session.title" "must not be empty"
                              else if Option.is_some archived_at then
                                error "session.archivedAt" "must be null"
                              else Ok id))))))
  | Ok _ -> Error "response must be a JSON object"
