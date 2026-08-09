(* Pure method, path, and query parsing for the control-plane HTTP API. *)

type session_action = Archive of string | Restore of string | Rename of string

type event_page =
  | After of { cursor : int64; limit : int }
  | Before of { cursor : int64; limit : int }
  | Recent of { limit : int }

type route =
  | Get_broker_sessions
  | Post_broker_send
  | Post_broker_subscribe
  | Post_broker_ask
  | Post_broker_collect
  | Get_workspaces
  | Post_workspace_delete of string
  | Get_workspace_directories of { query : string }
  | Post_workspaces
  | Get_sessions of { archived : bool }
  | Post_sessions
  | Post_session_action of session_action
  | Get_health
  | Get_session of { session_id : string option }
  | Get_file_mentions of { session_id : string option; query : string }
  | Get_config_options of { session_id : string option }
  | Post_config_options of { session_id : string option }
  | Get_event_stream of { session_id : string option; after : int64 }
  | Get_events of { session_id : string option; page : event_page }
  | Post_session_new
  | Post_commands of { session_id : string option }
  | Post_cancel of { session_id : string option }
  | Post_permissions of { session_id : string option }
  | Get_app_js
  | Get_asset of string
  | Method_not_allowed of { method_ : Cohttp.Code.meth; path : string }

let session_action path =
  match String.split_on_char '/' path with
  | [ ""; "api"; "v2"; "sessions"; id; "archive" ]
    when Lifecycle.valid_session_id id ->
      Some (Archive id)
  | [ ""; "api"; "v2"; "sessions"; id; "restore" ]
    when Lifecycle.valid_session_id id ->
      Some (Restore id)
  | [ ""; "api"; "v2"; "sessions"; id; "rename" ]
    when Lifecycle.valid_session_id id ->
      Some (Rename id)
  | _ -> None

let workspace_delete path =
  match String.split_on_char '/' path with
  | [ ""; "api"; "v2"; "workspaces"; id; "delete" ]
    when Lifecycle.valid_session_id id ->
      Some id
  | _ -> None

let parse_non_negative_cursor value =
  match Int64.of_string_opt value with
  | Some cursor when cursor >= 0L -> Ok cursor
  | _ -> Error "event cursor must be a non-negative integer"

let parse_after uri =
  match Uri.get_query_param uri "after" with
  | None -> Ok 0L
  | Some value -> parse_non_negative_cursor value

let parse_before uri =
  match Uri.get_query_param uri "before" with
  | None -> Error "before is required"
  | Some value -> (
      match parse_non_negative_cursor value with
      | Ok cursor when cursor > 0L -> Ok cursor
      | Ok _ -> Error "before must be a positive integer"
      | Error _ as error -> error)

let parse_limit value =
  try
    let limit = int_of_string value in
    if limit < 1 || limit > 500 then Error "limit must be between 1 and 500"
    else Ok limit
  with Failure _ -> Error "limit must be an integer"

let requested_limit uri default =
  match Uri.get_query_param uri "limit" with
  | None -> Ok default
  | Some value -> parse_limit value

let stream_after uri last_event_id =
  match parse_after uri with
  | Error _ as error -> error
  | Ok query_cursor -> (
      match last_event_id with
      | None | Some "" -> Ok query_cursor
      | Some value -> (
          match parse_non_negative_cursor value with
          | Error _ as error -> error
          | Ok header_cursor -> Ok (Int64.max query_cursor header_cursor)))

let event_page uri =
  match Uri.get_query_param uri "before" with
  | Some _ -> (
      match (parse_before uri, requested_limit uri 200) with
      | Ok cursor, Ok limit -> Ok (Before { cursor; limit })
      | Error message, _ | _, Error message -> Error message)
  | None -> (
      match Uri.get_query_param uri "recent" with
      | Some value ->
          Result.map (fun limit -> Recent { limit }) (parse_limit value)
      | None -> (
          match (parse_after uri, requested_limit uri 200) with
          | Ok cursor, Ok limit -> Ok (After { cursor; limit })
          | Error message, _ | _, Error message -> Error message))

let rec parse ~managed ~method_ ~uri ~last_event_id =
  let path = Uri.path uri in
  let session_id = Uri.get_query_param uri "session" in
  let query name = Uri.get_query_param uri name |> Option.value ~default:"" in
  if managed then
    match (method_, path, workspace_delete path, session_action path) with
    | `GET, "/api/v2/broker/sessions", _, _ -> Ok Get_broker_sessions
    | `POST, "/api/v2/broker/send", _, _ -> Ok Post_broker_send
    | `POST, "/api/v2/broker/subscribe", _, _ -> Ok Post_broker_subscribe
    | `POST, "/api/v2/broker/ask", _, _ -> Ok Post_broker_ask
    | `POST, "/api/v2/broker/collect", _, _ -> Ok Post_broker_collect
    | `GET, "/api/v2/workspaces", _, _ -> Ok Get_workspaces
    | `POST, _, Some id, _ -> Ok (Post_workspace_delete id)
    | `GET, "/api/v2/workspace-directories", _, _ ->
        Ok (Get_workspace_directories { query = query "query" })
    | `POST, "/api/v2/workspaces", _, _ -> Ok Post_workspaces
    | `GET, "/api/v2/sessions", _, _ ->
        Ok (Get_sessions { archived = query "archived" = "true" })
    | `POST, "/api/v2/sessions", _, _ -> Ok Post_sessions
    | `POST, _, _, Some action -> Ok (Post_session_action action)
    | _ -> parse_generic ~method_ ~uri ~last_event_id ~path ~session_id
  else parse_generic ~method_ ~uri ~last_event_id ~path ~session_id

and parse_generic ~method_ ~uri ~last_event_id ~path ~session_id =
  match (method_, path) with
  | `GET, "/health" -> Ok Get_health
  | `GET, "/api/v2/session" -> Ok (Get_session { session_id })
  | `GET, "/api/v2/file-mentions" ->
      Ok
        (Get_file_mentions
           {
             session_id;
             query = Uri.get_query_param uri "query" |> Option.value ~default:"";
           })
  | `GET, "/api/v2/config-options" -> Ok (Get_config_options { session_id })
  | `POST, "/api/v2/config-options" -> Ok (Post_config_options { session_id })
  | `GET, "/api/v2/event-stream" ->
      Result.map
        (fun after -> Get_event_stream { session_id; after })
        (stream_after uri last_event_id)
  | `GET, "/api/v2/events" ->
      Result.map (fun page -> Get_events { session_id; page }) (event_page uri)
  | `POST, "/api/v2/session/new" -> Ok Post_session_new
  | `POST, "/api/v2/commands" -> Ok (Post_commands { session_id })
  | `POST, "/api/v2/cancel" -> Ok (Post_cancel { session_id })
  | `POST, "/api/v2/permissions" -> Ok (Post_permissions { session_id })
  | `GET, "/app.js" -> Ok Get_app_js
  | `GET, resource -> Ok (Get_asset resource)
  | _ -> Ok (Method_not_allowed { method_; path })
