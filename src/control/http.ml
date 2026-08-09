(* HTTP request handler for the control plane. *)

open Cohttp
open Piss_core

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

let worker_socket workers session_id =
  match workers with
  | Config.Fixed path -> Ok path
  | Managed manager ->
      Result.map
        (fun (session : Registry.session) ->
          Lifecycle.session_socket manager.runtime_root session.id)
        (Workers.active_session manager session_id)

let with_worker workers session_id operation =
  match worker_socket workers session_id with
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
      let route =
        match
          Routes.parse
            ~managed:(match workers with Managed _ -> true | Fixed _ -> false)
            ~method_ ~uri
            ~last_event_id:
              (Header.get (Request.headers request) "last-event-id")
        with
        | Ok route -> route
        | Error message -> raise (Invalid_argument message)
      in
      let managed_response =
        match (workers : Config.workers) with
        | Managed manager ->
            Managed_routes.handle ~net ~clock ~manager ~allowed_origins
              ~dev_bypass ~calling_session ~request
              ~read_body:(fun () -> read_body body)
              route
        | Fixed _ -> None
      in
      match managed_response with
      | Some response -> response
      | None -> (
          match route with
          | Routes.Get_health ->
              Headers.respond_json
                (`Assoc
                   [
                     ("status", `String "ok");
                     ("generation", `String generation);
                     ("pid", `Int (Unix.getpid ()));
                   ])
          | Routes.Get_session { session_id } -> (
              match
                with_worker workers session_id (fun socket ->
                    Worker_client.request ~net ~socket
                      (`Assoc [ ("op", `String "snapshot") ]))
              with
              | Ok snapshot -> Headers.respond_json snapshot
              | Error message ->
                  Headers.error_json ~status:`Service_unavailable message)
          | Routes.Get_file_mentions { session_id; query } -> (
              let request =
                `Assoc
                  [ ("op", `String "file_search"); ("query", `String query) ]
              in
              match Wire.request_of_yojson request with
              | Error message -> Headers.error_json message
              | Ok _ -> (
                  match
                    with_worker workers session_id (fun socket ->
                        Worker_client.request ~net ~socket request)
                  with
                  | Ok mentions -> Headers.respond_json mentions
                  | Error message ->
                      Headers.error_json ~status:`Service_unavailable message))
          | Routes.Get_config_options { session_id } -> (
              match
                with_worker workers session_id (fun socket ->
                    Worker_client.request ~net ~socket
                      (`Assoc [ ("op", `String "config_options") ]))
              with
              | Ok options -> Headers.respond_json options
              | Error message ->
                  Headers.error_json ~status:`Service_unavailable message)
          | Routes.Post_config_options { session_id } -> (
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
                        with_worker workers session_id (fun socket ->
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
          | Routes.Get_event_stream { session_id; after } -> (
              match worker_socket workers session_id with
              | Error message ->
                  Headers.error_json ~status:`Service_unavailable message
              | Ok socket ->
                  (* TODO(tracer): Add a worker-side wait_events primitive
                     before supporting many concurrent observers per session;
                     this first browser stream uses bounded 250 ms reads. *)
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
                    ~headers:Headers.event_stream_headers ~body:stream ())
          | Routes.Get_events { session_id; page } -> (
              let worker_request =
                match page with
                | Routes.Before { cursor; limit } ->
                    `Assoc
                      [
                        ("op", `String "events_before");
                        ("before", `Intlit (Int64.to_string cursor));
                        ("limit", `Int limit);
                      ]
                | Routes.Recent { limit } ->
                    `Assoc
                      [ ("op", `String "recent_events"); ("limit", `Int limit) ]
                | Routes.After { cursor; limit } ->
                    `Assoc
                      [
                        ("op", `String "events");
                        ("after", `Intlit (Int64.to_string cursor));
                        ("limit", `Int limit);
                      ]
              in
              match
                with_worker workers session_id (fun socket ->
                    Worker_client.request ~net ~socket worker_request)
              with
              | Ok events -> Headers.respond_json events
              | Error message ->
                  Headers.error_json ~status:`Service_unavailable message)
          | Routes.Post_session_new -> (
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
          | Routes.Post_commands { session_id } -> (
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
                        with_worker workers session_id (fun socket ->
                            Worker_client.request ~net ~socket worker_json)
                      with
                      | Ok result ->
                          Headers.respond_json ~status:`Accepted result
                      | Error message ->
                          Headers.error_json ~status:`Service_unavailable
                            message)))
          | Routes.Post_cancel { session_id } -> (
              match
                Authentication.valid_json_mutation ~dev_bypass ~allowed_origins
                  request
              with
              | Error (status, message) -> Headers.error_json ~status message
              | Ok () -> (
                  ignore (read_body body);
                  match
                    with_worker workers session_id (fun socket ->
                        Worker_client.request ~net ~socket
                          (`Assoc [ ("op", `String "cancel") ]))
                  with
                  | Ok result -> Headers.respond_json ~status:`Accepted result
                  | Error message ->
                      Headers.error_json ~status:`Conflict message))
          | Routes.Post_permissions { session_id } -> (
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
                    with_worker workers session_id (fun socket ->
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
          | Routes.Get_app_js ->
              Assets.serve app_js "text/javascript; charset=utf-8"
          | Routes.Get_asset resource -> (
              match Assets.safe_asset_path public_dir resource with
              | Some (path, content_type) -> Assets.serve path content_type
              | None -> Headers.error_json ~status:`Not_found "not found")
          | Routes.Method_not_allowed { method_; path } ->
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
                (method_name ^ " not allowed for " ^ path)
          | Routes.Get_broker_sessions | Routes.Post_broker_send
          | Routes.Post_broker_subscribe | Routes.Post_broker_ask
          | Routes.Post_broker_collect | Routes.Get_workspaces
          | Routes.Post_workspace_delete _ | Routes.Get_workspace_directories _
          | Routes.Post_workspaces | Routes.Get_sessions _
          | Routes.Post_sessions | Routes.Post_session_action _ ->
              assert false)
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
