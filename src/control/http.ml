(* HTTP request handler for the control plane. *)

open Cohttp
open Piss_core

type session_action = Archive of string | Restore of string | Rename of string

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

let stream_after request uri =
  match parse_after uri with
  | Error _ as error -> error
  | Ok query_cursor -> (
      match Header.get (Request.headers request) "last-event-id" with
      | None | Some "" -> Ok query_cursor
      | Some value -> (
          match parse_non_negative_cursor value with
          | Error _ as error -> error
          | Ok header_cursor -> Ok (Int64.max query_cursor header_cursor)))

let parse_limit value =
  try
    let limit = int_of_string value in
    if limit < 1 || limit > 500 then Error "limit must be between 1 and 500"
    else Ok limit
  with Failure _ -> Error "limit must be an integer"

let read_body body =
  Eio.Buf_read.of_flow body ~max_size:Config.max_body_bytes
  |> Eio.Buf_read.take_all

let broker_source (workers : Config.workers) request =
  match workers with
  | Fixed _ -> None
  | Managed manager -> (
      let open Authentication in
      match request_header request "x-piss-session-token" with
      | Some token -> Registry.find_active_by_token manager.registry token
      | None -> None)

let with_worker workers uri operation =
  match Workers.worker_socket workers uri with
  | Ok socket -> operation socket
  | Error message -> Error message

let handler ~net ~clock ~env _socket request body =
  let workers = env.Config.workers in
  let public_dir = env.public_dir in
  let app_js = env.app_js in
  let generation = env.generation in
  let allowed_users = env.allowed_users in
  let allowed_origins = env.allowed_origins in
  let dev_bypass = env.dev_bypass in
  let resource = Request.resource request in
  let uri = Uri.of_string resource in
  let path = Uri.path uri in
  let method_ = Request.meth request in
  try
    let calling_session = broker_source workers request in
    let is_broker_path = String.starts_with ~prefix:"/api/v2/broker/" path in
    if
      (not (String.equal path "/health"))
      && Option.is_none calling_session
      && not (Authentication.authorized ~allowed_users ~dev_bypass request)
    then
      Headers.error_json ~status:`Unauthorized
        (if is_broker_path then "session broker token is not authorized"
         else "Tailscale identity is not authorized")
    else
      let managed_response =
        match
          ((workers : Config.workers), method_, path, session_action path)
        with
        | Managed manager, `GET, "/api/v2/broker/sessions", _ ->
            Some
              (match calling_session with
              | None ->
                  Headers.error_json ~status:`Unauthorized
                    "broker token required"
              | Some caller ->
                  Registry.list manager.registry ~include_archived:false
                  |> List.map (fun (session : Registry.session) ->
                      `Assoc
                        [
                          ("id", `String session.Registry.id);
                          ("title", `String session.title);
                          ("harness", `String session.harness);
                          ("self", `Bool (String.equal caller.id session.id));
                        ])
                  |> fun sessions -> Headers.respond_json (`List sessions))
        | Managed manager, `POST, "/api/v2/broker/send", _ ->
            Some
              (match calling_session with
              | None ->
                  Headers.error_json ~status:`Unauthorized
                    "broker token required"
              | Some source -> (
                  match Authentication.valid_json_content request with
                  | Error (status, message) ->
                      Headers.error_json ~status message
                  | Ok () -> (
                      let json = read_body body |> Yojson.Safe.from_string in
                      match
                        Broker.send_peer_request ~net manager ~source json
                      with
                      | Error message ->
                          Headers.error_json ~status:`Conflict message
                      | Ok (peer_request, duplicate) ->
                          Headers.respond_json ~status:`Accepted
                            (`Assoc
                               [
                                 ("requestId", `String peer_request.id);
                                 ("state", `String peer_request.state);
                                 ("duplicate", `Bool duplicate);
                               ]))))
        | Managed manager, `POST, "/api/v2/broker/subscribe", _ ->
            Some
              (match calling_session with
              | None ->
                  Headers.error_json ~status:`Unauthorized
                    "broker token required"
              | Some source -> (
                  match Authentication.valid_json_content request with
                  | Error (status, message) ->
                      Headers.error_json ~status message
                  | Ok () -> (
                      let json = read_body body |> Yojson.Safe.from_string in
                      match
                        Broker.accept_peer_subscription manager ~source json
                      with
                      | Error message ->
                          Headers.error_json ~status:`Conflict message
                      | Ok (subscription, duplicate) ->
                          Headers.respond_json ~status:`Accepted
                            (`Assoc
                               [
                                 ("subscriptionId", `String subscription.id);
                                 ("state", `String subscription.state);
                                 ("duplicate", `Bool duplicate);
                               ]))))
        | Managed manager, `POST, "/api/v2/broker/ask", _ ->
            Some
              (match calling_session with
              | None ->
                  Headers.error_json ~status:`Unauthorized
                    "broker token required"
              | Some source -> (
                  match Authentication.valid_json_content request with
                  | Error (status, message) ->
                      Headers.error_json ~status message
                  | Ok () -> (
                      let json = read_body body |> Yojson.Safe.from_string in
                      match
                        Broker.send_peer_request ~net manager ~source json
                      with
                      | Error message ->
                          Headers.error_json ~status:`Conflict message
                      | Ok (peer_request, duplicate) -> (
                          match
                            Broker.wait_for_peer_response ~net ~clock manager
                              ~source peer_request
                          with
                          | Error message ->
                              Headers.error_json ~status:`Service_unavailable
                                message
                          | Ok response ->
                              Headers.respond_json
                                (`Assoc
                                   [
                                     ("requestId", `String peer_request.id);
                                     ("response", `String response);
                                     ("duplicate", `Bool duplicate);
                                   ])))))
        | Managed manager, `POST, "/api/v2/broker/collect", _ ->
            Some
              (match calling_session with
              | None ->
                  Headers.error_json ~status:`Unauthorized
                    "broker token required"
              | Some source -> (
                  match Authentication.valid_json_content request with
                  | Error (status, message) ->
                      Headers.error_json ~status message
                  | Ok () ->
                      let json = read_body body |> Yojson.Safe.from_string in
                      let open Yojson.Safe.Util in
                      let request_ids =
                        json |> member "requestIds" |> to_list
                        |> List.map to_string
                        |> List.sort_uniq String.compare
                      in
                      let wait_for =
                        match member "waitFor" json with
                        | `String value -> value
                        | _ -> "all"
                      in
                      let timeout =
                        match member "timeoutSeconds" json with
                        | `Int value -> float_of_int value
                        | `Float value -> value
                        | _ -> 600.
                      in
                      if request_ids = [] || List.length request_ids > 64 then
                        Headers.error_json
                          "requestIds must contain between 1 and 64 identities"
                      else if timeout < 0. || timeout > 600. then
                        Headers.error_json
                          "timeoutSeconds must be between 0 and 600"
                      else if not (List.mem wait_for [ "any"; "all" ]) then
                        Headers.error_json "waitFor must be 'any' or 'all'"
                      else
                        let finished, pending =
                          Broker.collect_peer_requests ~net ~clock manager
                            ~source ~request_ids ~wait_for ~timeout
                        in
                        Headers.respond_json
                          (`Assoc
                             [
                               ( "responses",
                                 `List
                                   (List.map Broker.peer_request_json finished)
                               );
                               ( "pendingRequestIds",
                                 `List
                                   (List.map
                                      (fun (request : Registry.peer_request) ->
                                        `String request.id)
                                      pending) );
                             ])))
        | Managed manager, `GET, "/api/v2/workspaces", _ ->
            Some
              ( Registry.list_workspaces manager.registry
              |> List.map Registry.workspace_to_yojson
              |> fun workspaces -> Headers.respond_json (`List workspaces) )
        | Managed manager, `POST, _, _
          when Option.is_some (workspace_delete path) ->
            Some
              (match
                 Authentication.valid_json_mutation ~dev_bypass ~allowed_origins
                   request
               with
              | Error (status, message) -> Headers.error_json ~status message
              | Ok () -> (
                  ignore (read_body body);
                  let id = Option.get (workspace_delete path) in
                  match Registry.find_workspace manager.registry id with
                  | None ->
                      Headers.error_json ~status:`Not_found
                        "workspace not found"
                  | Some workspace ->
                      let session_count =
                        Registry.workspace_session_count manager.registry id
                      in
                      if session_count > 0 then
                        Headers.error_json ~status:`Conflict
                          (Printf.sprintf
                             "Delete %d %s first, including archived sessions"
                             session_count
                             (if session_count = 1 then "session"
                              else "sessions"))
                      else if
                        not (Registry.remove_workspace manager.registry id)
                      then
                        Headers.error_json ~status:`Conflict
                          "workspace was not removed"
                      else (
                        (if String.equal manager.default_workspace_id id then
                           match Registry.list_workspaces manager.registry with
                           | replacement :: _ ->
                               manager.default_workspace_id <- replacement.id
                           | [] -> ());
                        Headers.respond_json
                          (`Assoc
                             [
                               ("removed", `Bool true);
                               ("id", `String workspace.id);
                             ]))))
        | Managed manager, `GET, "/api/v2/workspace-directories", _ ->
            let query =
              Uri.get_query_param uri "query" |> Option.value ~default:""
            in
            Some
              ( Workspaces.search_workspace_directories
                  manager.workspace_discovery_roots query
              |> List.map (fun path ->
                  `Assoc
                    [
                      ("path", `String path);
                      ("name", `String (Workspaces.workspace_name path));
                    ])
              |> fun directories -> Headers.respond_json (`List directories) )
        | Managed manager, `POST, "/api/v2/workspaces", _ ->
            Some
              (match
                 Authentication.valid_json_mutation ~dev_bypass ~allowed_origins
                   request
               with
              | Error (status, message) -> Headers.error_json ~status message
              | Ok () -> (
                  let json = read_body body |> Yojson.Safe.from_string in
                  let open Yojson.Safe.Util in
                  let requested_path =
                    match member "path" json with
                    | `String value -> value
                    | _ -> ""
                  in
                  match Workspaces.canonical_directory requested_path with
                  | None ->
                      Headers.error_json "Choose an existing local directory"
                  | Some path
                    when not
                           (List.exists
                              (fun root -> Workspaces.path_within ~root path)
                              manager.workspace_discovery_roots) ->
                      Headers.error_json ~status:`Forbidden
                        "Directory is outside the approved local roots"
                  | Some path ->
                      let workspace =
                        match
                          Registry.find_workspace_by_root manager.registry path
                        with
                        | Some workspace -> workspace
                        | None ->
                            let id = Workspaces.workspace_id_for_path path in
                            Registry.upsert_workspace manager.registry ~id
                              ~name:(Workspaces.workspace_name path)
                              ~root:path;
                            Option.get
                              (Registry.find_workspace manager.registry id)
                      in
                      Headers.respond_json ~status:`Created
                        (Registry.workspace_to_yojson workspace)))
        | Managed manager, `GET, "/api/v2/sessions", _ ->
            let sessions =
              match Uri.get_query_param uri "archived" with
              | Some "true" ->
                  Registry.list_archived manager.registry
                  |> List.map (fun session ->
                      match Registry.session_to_yojson session with
                      | `Assoc fields ->
                          `Assoc (("status", `String "archived") :: fields)
                      | _ -> assert false)
              | _ ->
                  Registry.list manager.registry ~include_archived:false
                  |> List.map (Workers.summary ~net manager)
            in
            Some (Headers.respond_json (`List sessions))
        | Managed manager, `POST, "/api/v2/sessions", _ ->
            Some
              (match
                 Authentication.valid_json_mutation ~dev_bypass ~allowed_origins
                   request
               with
              | Error (status, message) -> Headers.error_json ~status message
              | Ok () -> (
                  let json = read_body body |> Yojson.Safe.from_string in
                  let open Yojson.Safe.Util in
                  let harness =
                    match member "harness" json with
                    | `String value -> value
                    | _ -> manager.default_harness
                  in
                  let workspace_id =
                    match member "workspaceId" json with
                    | `String value -> value
                    | _ -> manager.default_workspace_id
                  in
                  let title =
                    match member "title" json with
                    | `String value -> value
                    | _ ->
                        if String.equal harness "opencode" then
                          "New OpenCode session"
                        else "New Pi session"
                  in
                  match
                    Workers.create_managed_session manager ~harness
                      ~workspace_id ~title
                  with
                  | Ok session ->
                      Headers.respond_json ~status:`Created
                        (Registry.session_to_yojson session)
                  | Error message ->
                      Headers.error_json ~status:`Conflict message))
        | Managed manager, `POST, _, Some action ->
            Some
              (match
                 Authentication.valid_json_mutation ~dev_bypass ~allowed_origins
                   request
               with
              | Error (status, message) -> Headers.error_json ~status message
              | Ok () -> (
                  let request_body = read_body body in
                  match action with
                  | Archive id -> (
                      match Workers.archive_managed_session manager id with
                      | Ok () ->
                          Headers.respond_json
                            (`Assoc [ ("archived", `Bool true) ])
                      | Error message ->
                          Headers.error_json ~status:`Conflict message)
                  | Restore id -> (
                      match Workers.restore_managed_session manager id with
                      | Ok () ->
                          Headers.respond_json
                            (`Assoc [ ("restored", `Bool true) ])
                      | Error message ->
                          Headers.error_json ~status:`Conflict message)
                  | Rename id ->
                      let json = Yojson.Safe.from_string request_body in
                      let title =
                        Yojson.Safe.Util.member "title" json
                        |> Yojson.Safe.Util.to_string |> String.trim
                      in
                      if not (Lifecycle.valid_title title) then
                        Headers.error_json
                          "title must contain between 1 and 120 characters"
                      else if Registry.rename_session manager.registry id title
                      then
                        Headers.respond_json
                          (`Assoc
                             [
                               ("renamed", `Bool true); ("title", `String title);
                             ])
                      else
                        Headers.error_json ~status:`Not_found
                          "session not found"))
        | _ -> None
      in
      match managed_response with
      | Some response -> response
      | None -> (
          match (method_, path) with
          | `GET, "/health" ->
              Headers.respond_json
                (`Assoc
                   [
                     ("status", `String "ok");
                     ("generation", `String generation);
                     ("pid", `Int (Unix.getpid ()));
                   ])
          | `GET, "/api/v2/session" -> (
              match
                with_worker workers uri (fun socket ->
                    Worker_client.request ~net ~socket
                      (`Assoc [ ("op", `String "snapshot") ]))
              with
              | Ok snapshot -> Headers.respond_json snapshot
              | Error message ->
                  Headers.error_json ~status:`Service_unavailable message)
          | `GET, "/api/v2/file-mentions" -> (
              let query =
                Uri.get_query_param uri "query" |> Option.value ~default:""
              in
              let request =
                `Assoc
                  [ ("op", `String "file_search"); ("query", `String query) ]
              in
              match Wire.request_of_yojson request with
              | Error message -> Headers.error_json message
              | Ok _ -> (
                  match
                    with_worker workers uri (fun socket ->
                        Worker_client.request ~net ~socket request)
                  with
                  | Ok mentions -> Headers.respond_json mentions
                  | Error message ->
                      Headers.error_json ~status:`Service_unavailable message))
          | `GET, "/api/v2/config-options" -> (
              match
                with_worker workers uri (fun socket ->
                    Worker_client.request ~net ~socket
                      (`Assoc [ ("op", `String "config_options") ]))
              with
              | Ok options -> Headers.respond_json options
              | Error message ->
                  Headers.error_json ~status:`Service_unavailable message)
          | `POST, "/api/v2/config-options" -> (
              match
                Authentication.valid_json_mutation ~dev_bypass ~allowed_origins
                  request
              with
              | Error (status, message) -> Headers.error_json ~status message
              | Ok () -> (
                  let json = read_body body |> Yojson.Safe.from_string in
                  match
                    ( Yojson.Safe.Util.member "configId" json,
                      Yojson.Safe.Util.member "value" json )
                  with
                  | `String config_id, `String value -> (
                      match
                        with_worker workers uri (fun socket ->
                            Worker_client.request ~net ~socket
                              (`Assoc
                                 [
                                   ("op", `String "set_config_option");
                                   ("configId", `String config_id);
                                   ("value", `String value);
                                 ]))
                      with
                      | Ok result -> Headers.respond_json result
                      | Error message ->
                          Headers.error_json ~status:`Conflict message)
                  | _ -> Headers.error_json "configId and value must be strings"
                  ))
          | `GET, "/api/v2/event-stream" -> (
              match stream_after request uri with
              | Error message -> Headers.error_json message
              | Ok after -> (
                  match Workers.worker_socket workers uri with
                  | Error message ->
                      Headers.error_json ~status:`Service_unavailable message
                  | Ok socket ->
                      (* TODO(tracer): Add a worker-side wait_events primitive
                         before supporting many concurrent observers per
                         session; this first browser stream uses bounded 250 ms
                         reads. *)
                      let fetch cursor =
                        match
                          Worker_client.request ~net ~socket
                            (`Assoc
                               [
                                 ("op", `String "events");
                                 ("after", `Intlit (Int64.to_string cursor));
                                 ("limit", `Int 200);
                               ])
                        with
                        | Ok (`List events) -> Ok events
                        | Ok _ -> Error "worker returned an invalid event page"
                        | Error message -> Error message
                      in
                      let stream =
                        Event_stream.source ~fetch ~after
                          ~sleep:(Eio.Time.sleep clock)
                      in
                      Cohttp_eio.Server.respond ~status:`OK
                        ~headers:Headers.event_stream_headers ~body:stream ()))
          | `GET, "/api/v2/events" -> (
              let requested_limit default =
                match Uri.get_query_param uri "limit" with
                | None -> Ok default
                | Some value -> parse_limit value
              in
              let request =
                match Uri.get_query_param uri "before" with
                | Some _ -> (
                    match (parse_before uri, requested_limit 200) with
                    | Ok before, Ok limit ->
                        Ok
                          (`Assoc
                             [
                               ("op", `String "events_before");
                               ("before", `Intlit (Int64.to_string before));
                               ("limit", `Int limit);
                             ])
                    | Error message, _ | _, Error message -> Error message)
                | None -> (
                    match Uri.get_query_param uri "recent" with
                    | Some value -> (
                        match parse_limit value with
                        | Ok limit ->
                            Ok
                              (`Assoc
                                 [
                                   ("op", `String "recent_events");
                                   ("limit", `Int limit);
                                 ])
                        | Error message -> Error message)
                    | None -> (
                        match (parse_after uri, requested_limit 200) with
                        | Ok after, Ok limit ->
                            Ok
                              (`Assoc
                                 [
                                   ("op", `String "events");
                                   ("after", `Intlit (Int64.to_string after));
                                   ("limit", `Int limit);
                                 ])
                        | Error message, _ | _, Error message -> Error message))
              in
              match request with
              | Error message -> Headers.error_json message
              | Ok request -> (
                  match
                    with_worker workers uri (fun socket ->
                        Worker_client.request ~net ~socket request)
                  with
                  | Ok events -> Headers.respond_json events
                  | Error message ->
                      Headers.error_json ~status:`Service_unavailable message))
          | `POST, "/api/v2/session/new" -> (
              match
                Authentication.valid_json_mutation ~dev_bypass ~allowed_origins
                  request
              with
              | Error (status, message) -> Headers.error_json ~status message
              | Ok () -> (
                  ignore (read_body body);
                  match workers with
                  | Managed manager -> (
                      match
                        Workers.create_managed_session manager
                          ~harness:manager.default_harness
                          ~workspace_id:manager.default_workspace_id
                          ~title:"New session"
                      with
                      | Ok session ->
                          Headers.respond_json ~status:`Created
                            (Registry.session_to_yojson session)
                      | Error message ->
                          Headers.error_json ~status:`Conflict message)
                  | Fixed socket -> (
                      match
                        Worker_client.request ~net ~socket
                          (`Assoc [ ("op", `String "new_session") ])
                      with
                      | Ok result ->
                          Headers.respond_json ~status:`Created result
                      | Error message ->
                          Headers.error_json ~status:`Conflict message)))
          | `POST, "/api/v2/commands" -> (
              match
                Authentication.valid_json_mutation ~dev_bypass ~allowed_origins
                  request
              with
              | Error (status, message) -> Headers.error_json ~status message
              | Ok () -> (
                  let json = read_body body |> Yojson.Safe.from_string in
                  let open Yojson.Safe.Util in
                  let action =
                    match json |> member "action" with
                    | `String value -> value
                    | _ -> "prompt"
                  in
                  let worker_json =
                    `Assoc
                      ([
                         ( "op",
                           `String
                             (if action = "prompt" then "prompt" else "deliver")
                         );
                         ("commandId", json |> member "commandId");
                         ("text", json |> member "text");
                         ( "images",
                           match json |> member "images" with
                           | `Null -> `List []
                           | value -> value );
                         ( "resources",
                           match json |> member "resources" with
                           | `Null -> `List []
                           | value -> value );
                       ]
                      @
                      if action = "prompt" then []
                      else [ ("action", `String action) ])
                  in
                  match Wire.request_of_yojson worker_json with
                  | Error message -> Headers.error_json message
                  | Ok _ -> (
                      match
                        with_worker workers uri (fun socket ->
                            Worker_client.request ~net ~socket worker_json)
                      with
                      | Ok result ->
                          Headers.respond_json ~status:`Accepted result
                      | Error message ->
                          Headers.error_json ~status:`Service_unavailable
                            message)))
          | `POST, "/api/v2/cancel" -> (
              match
                Authentication.valid_json_mutation ~dev_bypass ~allowed_origins
                  request
              with
              | Error (status, message) -> Headers.error_json ~status message
              | Ok () -> (
                  ignore (read_body body);
                  match
                    with_worker workers uri (fun socket ->
                        Worker_client.request ~net ~socket
                          (`Assoc [ ("op", `String "cancel") ]))
                  with
                  | Ok result -> Headers.respond_json ~status:`Accepted result
                  | Error message ->
                      Headers.error_json ~status:`Conflict message))
          | `POST, "/api/v2/permissions" -> (
              match
                Authentication.valid_json_mutation ~dev_bypass ~allowed_origins
                  request
              with
              | Error (status, message) -> Headers.error_json ~status message
              | Ok () -> (
                  let json = read_body body |> Yojson.Safe.from_string in
                  let open Yojson.Safe.Util in
                  let request_id = json |> member "requestId" |> to_string in
                  let option_id =
                    match member "optionId" json with
                    | `String value -> `String value
                    | `Null -> `Null
                    | _ ->
                        raise
                          (Type_error ("optionId must be a string or null", json))
                  in
                  match
                    with_worker workers uri (fun socket ->
                        Worker_client.request ~net ~socket
                          (`Assoc
                             [
                               ("op", `String "permission");
                               ("requestId", `String request_id);
                               ("optionId", option_id);
                             ]))
                  with
                  | Ok result -> Headers.respond_json result
                  | Error message ->
                      Headers.error_json ~status:`Conflict message))
          | `GET, "/app.js" ->
              Assets.serve app_js "text/javascript; charset=utf-8"
          | `GET, resource -> (
              match Assets.safe_asset_path public_dir resource with
              | Some (path, content_type) -> Assets.serve path content_type
              | None -> Headers.error_json ~status:`Not_found "not found")
          | _ ->
              let method_name =
                match method_ with
                | `GET -> "GET"
                | `POST -> "POST"
                | `PUT -> "PUT"
                | `DELETE -> "DELETE"
                | `PATCH -> "PATCH"
                | `HEAD -> "HEAD"
                | `OPTIONS -> "OPTIONS"
                | `CONNECT -> "CONNECT"
                | `TRACE -> "TRACE"
                | `Other value -> value
              in
              Headers.error_json ~status:`Method_not_allowed
                (method_name ^ " not allowed for " ^ path))
  with
  | Eio.Io _ as exn ->
      Headers.error_json ~status:`Service_unavailable (Printexc.to_string exn)
  | Eio.Buf_read.Buffer_limit_exceeded ->
      Headers.error_json ~status:`Request_entity_too_large
        "request body is too large"
  | Yojson.Json_error message -> Headers.error_json ("invalid JSON: " ^ message)
  | Yojson.Safe.Util.Type_error (message, _) -> Headers.error_json message
  | Invalid_argument message -> Headers.error_json message
  | exn ->
      Headers.error_json ~status:`Internal_server_error (Printexc.to_string exn)
