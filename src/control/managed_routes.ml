(* Effectful handling for routes available only in managed-worker mode. *)

open Piss_core

let validation ?(field = "request") reason = Error.Validation { field; reason }
let conflict reason = Error.Conflict { reason }
let forbidden reason = Error.Forbidden { reason }
let upstream message = Error.Upstream_unavailable { message }

let authentication_error status reason =
  match status with `Forbidden -> forbidden reason | _ -> validation reason

let handle ~net ~clock ~process_mgr ~(manager : Config.managed_workers)
    ~allowed_origins ~dev_bypass ~(calling_session : Registry.session option)
    ~request ~read_body route =
  match route with
  | Routes.Get_broker_sessions ->
      Some
        (match calling_session with
        | None ->
            Headers.error_json ~status:`Unauthorized
              (forbidden "broker token required")
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
  | Routes.Post_broker_send ->
      Some
        (match calling_session with
        | None ->
            Headers.error_json ~status:`Unauthorized
              (forbidden "broker token required")
        | Some source -> (
            match Authentication.valid_json_content request with
            | Error (status, message) ->
                Headers.error_json ~status (authentication_error status message)
            | Ok () -> (
                let json = read_body () |> Yojson.Safe.from_string in
                match Broker.send_peer_request ~net manager ~source json with
                | Error message -> Headers.error_json (conflict message)
                | Ok (peer_request, duplicate) ->
                    Headers.respond_json ~status:`Accepted
                      (`Assoc
                         [
                           ("requestId", `String peer_request.id);
                           ("state", `String peer_request.state);
                           ("duplicate", `Bool duplicate);
                         ]))))
  | Routes.Post_broker_subscribe ->
      Some
        (match calling_session with
        | None ->
            Headers.error_json ~status:`Unauthorized
              (forbidden "broker token required")
        | Some source -> (
            match Authentication.valid_json_content request with
            | Error (status, message) ->
                Headers.error_json ~status (authentication_error status message)
            | Ok () -> (
                let json = read_body () |> Yojson.Safe.from_string in
                match Broker.accept_peer_subscription manager ~source json with
                | Error message -> Headers.error_json (conflict message)
                | Ok (subscription, duplicate) ->
                    Headers.respond_json ~status:`Accepted
                      (`Assoc
                         [
                           ("subscriptionId", `String subscription.id);
                           ("state", `String subscription.state);
                           ("duplicate", `Bool duplicate);
                         ]))))
  | Routes.Post_broker_ask ->
      Some
        (match calling_session with
        | None ->
            Headers.error_json ~status:`Unauthorized
              (forbidden "broker token required")
        | Some source -> (
            match Authentication.valid_json_content request with
            | Error (status, message) ->
                Headers.error_json ~status (authentication_error status message)
            | Ok () -> (
                let json = read_body () |> Yojson.Safe.from_string in
                match Broker.send_peer_request ~net manager ~source json with
                | Error message -> Headers.error_json (conflict message)
                | Ok (peer_request, duplicate) -> (
                    match
                      Broker.wait_for_peer_response ~net ~clock manager ~source
                        peer_request
                    with
                    | Error message -> Headers.error_json (upstream message)
                    | Ok response ->
                        Headers.respond_json
                          (`Assoc
                             [
                               ("requestId", `String peer_request.id);
                               ("response", `String response);
                               ("duplicate", `Bool duplicate);
                             ])))))
  | Routes.Post_broker_collect ->
      Some
        (match calling_session with
        | None ->
            Headers.error_json ~status:`Unauthorized
              (forbidden "broker token required")
        | Some source -> (
            match Authentication.valid_json_content request with
            | Error (status, message) ->
                Headers.error_json ~status (authentication_error status message)
            | Ok () ->
                let json = read_body () |> Yojson.Safe.from_string in
                let open Yojson.Safe.Util in
                let request_ids =
                  json |> member "requestIds" |> to_list |> List.map to_string
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
                    (validation ~field:"requestIds"
                       "requestIds must contain between 1 and 64 identities")
                else if timeout < 0. || timeout > 600. then
                  Headers.error_json
                    (validation ~field:"timeoutSeconds"
                       "timeoutSeconds must be between 0 and 600")
                else if not (List.mem wait_for [ "any"; "all" ]) then
                  Headers.error_json
                    (validation ~field:"waitFor"
                       "waitFor must be 'any' or 'all'")
                else
                  let finished, pending =
                    Broker.collect_peer_requests ~net ~clock manager ~source
                      ~request_ids ~wait_for ~timeout
                  in
                  Headers.respond_json
                    (`Assoc
                       [
                         ( "responses",
                           `List (List.map Broker.peer_request_json finished) );
                         ( "pendingRequestIds",
                           `List
                             (List.map
                                (fun (request : Registry.peer_request) ->
                                  `String request.id)
                                pending) );
                       ])))
  | Routes.Get_workspaces ->
      Some
        ( Registry.list_workspaces manager.registry
        |> List.map Registry.workspace_to_yojson
        |> fun workspaces -> Headers.respond_json (`List workspaces) )
  | Routes.Get_session_creation ->
      Some
        (Headers.respond_json
           (`Assoc
              [
                ( "availableHarnesses",
                  `List
                    (List.map
                       (fun harness -> `String harness)
                       manager.available_harnesses) );
                ("defaultHarness", `String manager.default_harness);
              ]))
  | Routes.Post_workspace_delete id ->
      Some
        (match
           Authentication.valid_json_mutation ~dev_bypass ~allowed_origins
             request
         with
        | Error (status, message) ->
            Headers.error_json ~status (authentication_error status message)
        | Ok () -> (
            ignore (read_body ());
            match Registry.find_workspace manager.registry id with
            | None ->
                Headers.error_json
                  (Error.Not_found { resource = "workspace"; id })
            | Some workspace ->
                let session_count =
                  Registry.workspace_session_count manager.registry id
                in
                if session_count > 0 then
                  Headers.error_json
                    (conflict
                       (Printf.sprintf
                          "Delete %d %s first, including archived sessions"
                          session_count
                          (if session_count = 1 then "session" else "sessions")))
                else if not (Registry.remove_workspace manager.registry id) then
                  Headers.error_json (conflict "workspace was not removed")
                else (
                  (if String.equal manager.default_workspace_id id then
                     match Registry.list_workspaces manager.registry with
                     | replacement :: _ ->
                         manager.default_workspace_id <- replacement.id
                     | [] -> ());
                  Headers.respond_json
                    (`Assoc
                       [ ("removed", `Bool true); ("id", `String workspace.id) ]))
            ))
  | Routes.Get_workspace_directories { query } ->
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
  | Routes.Post_workspaces ->
      Some
        (match
           Authentication.valid_json_mutation ~dev_bypass ~allowed_origins
             request
         with
        | Error (status, message) ->
            Headers.error_json ~status (authentication_error status message)
        | Ok () -> (
            let json = read_body () |> Yojson.Safe.from_string in
            let open Yojson.Safe.Util in
            let requested_path =
              match member "path" json with `String value -> value | _ -> ""
            in
            match Workspaces.canonical_directory requested_path with
            | None ->
                Headers.error_json
                  (validation ~field:"path" "Choose an existing local directory")
            | Some path
              when not
                     (List.exists
                        (fun root -> Workspaces.path_within ~root path)
                        manager.workspace_discovery_roots) ->
                Headers.error_json
                  (forbidden "Directory is outside the approved local roots")
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
                      Option.get (Registry.find_workspace manager.registry id)
                in
                Headers.respond_json ~status:`Created
                  (Registry.workspace_to_yojson workspace)))
  | Routes.Get_sessions { archived } ->
      let sessions =
        if archived then
          Registry.list_archived manager.registry
          |> List.map (fun session ->
              match Registry.session_to_yojson session with
              | `Assoc fields ->
                  `Assoc (("status", `String "archived") :: fields)
              | _ -> assert false)
        else
          Registry.list manager.registry ~include_archived:false
          |> List.map (Workers.summary ~net manager)
      in
      Some (Headers.respond_json (`List sessions))
  | Routes.Get_session_audit session_id ->
      Some
        (match calling_session with
        | Some _ ->
            Headers.error_json ~status:`Forbidden
              (forbidden "session broker tokens cannot read workspace audits")
        | None -> (
            match Registry.find_active manager.registry session_id with
            | None ->
                Headers.error_json
                  (Error.Not_found
                     { resource = "active session"; id = session_id })
            | Some session -> (
                match
                  Registry.find_workspace manager.registry session.workspace_id
                with
                | None ->
                    Headers.error_json
                      (Error.Not_found
                         {
                           resource = "session workspace";
                           id = session.workspace_id;
                         })
                | Some workspace -> (
                    match
                      Audit.collect ~process_mgr ~clock ~root:workspace.root
                        ~approved_roots:
                          (workspace.root :: manager.workspace_discovery_roots)
                    with
                    | Error error ->
                        Headers.error_json (Audit.to_control_error error)
                    | Ok snapshot ->
                        Headers.respond_json
                          (`Assoc
                             [ ("audit", Audit.snapshot_to_yojson snapshot) ])))
            ))
  | Routes.Post_sessions ->
      Some
        (match
           Authentication.valid_json_mutation ~dev_bypass ~allowed_origins
             request
         with
        | Error (status, message) ->
            Headers.error_json ~status (authentication_error status message)
        | Ok () -> (
            let json = read_body () |> Yojson.Safe.from_string in
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
                  if String.equal harness "opencode" then "New OpenCode session"
                  else "New Pi session"
            in
            match
              Workers.create_managed_session manager ~harness ~workspace_id
                ~title
            with
            | Ok session ->
                Headers.respond_json ~status:`Created
                  (Registry.session_to_yojson session)
            | Error message -> Headers.error_json (conflict message)))
  | Routes.Post_archived_sessions_delete ->
      Some
        (match
           Authentication.valid_json_mutation ~dev_bypass ~allowed_origins
             request
         with
        | Error (status, message) ->
            Headers.error_json ~status (authentication_error status message)
        | Ok () -> (
            let json = read_body () |> Yojson.Safe.from_string in
            let open Yojson.Safe.Util in
            let requested_ids =
              match member "ids" json with
              | `Null -> Ok None
              | `List values ->
                  let ids = List.map to_string values in
                  if ids = [] then Error "select at least one archived session"
                  else if List.length ids > 500 then
                    Error "select at most 500 archived sessions"
                  else if
                    List.length (List.sort_uniq String.compare ids)
                    <> List.length ids
                  then Error "selected session ids must be unique"
                  else if
                    List.exists
                      (fun id -> not (Lifecycle.valid_session_id id))
                      ids
                  then Error "selected session id is invalid"
                  else Ok (Some ids)
              | _ -> Error "ids must be an array of session ids"
            in
            match requested_ids with
            | Error message ->
                Headers.error_json (validation ~field:"ids" message)
            | Ok ids -> (
                match Workers.delete_archived_sessions ?ids manager with
                | Ok deleted ->
                    Headers.respond_json (`Assoc [ ("deleted", `Int deleted) ])
                | Error message -> Headers.error_json (conflict message))))
  | Routes.Post_session_action action ->
      Some
        (match
           Authentication.valid_json_mutation ~dev_bypass ~allowed_origins
             request
         with
        | Error (status, message) ->
            Headers.error_json ~status (authentication_error status message)
        | Ok () -> (
            let request_body = read_body () in
            match action with
            | Routes.Archive id -> (
                match Workers.archive_managed_session manager id with
                | Ok () ->
                    Headers.respond_json (`Assoc [ ("archived", `Bool true) ])
                | Error message -> Headers.error_json (conflict message))
            | Routes.Restore id -> (
                match Workers.restore_managed_session manager id with
                | Ok () ->
                    Headers.respond_json (`Assoc [ ("restored", `Bool true) ])
                | Error message -> Headers.error_json (conflict message))
            | Routes.Rename id ->
                let json = Yojson.Safe.from_string request_body in
                let title =
                  Yojson.Safe.Util.member "title" json
                  |> Yojson.Safe.Util.to_string |> String.trim
                in
                if not (Lifecycle.valid_title title) then
                  Headers.error_json
                    (validation ~field:"title"
                       "title must contain between 1 and 120 characters")
                else if Registry.rename_session manager.registry id title then
                  Headers.respond_json
                    (`Assoc
                       [ ("renamed", `Bool true); ("title", `String title) ])
                else
                  Headers.error_json
                    (Error.Not_found { resource = "session"; id })))
  | _ -> None
