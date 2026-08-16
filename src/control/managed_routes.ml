(* Effectful handling for routes available only in managed-worker mode. *)

open Piss_core

let validation ?(field = "request") reason = Error.Validation { field; reason }
let conflict reason = Error.Conflict { reason }
let forbidden reason = Error.Forbidden { reason }
let upstream message = Error.Upstream_unavailable { message }

let authentication_error status reason =
  match status with `Forbidden -> forbidden reason | _ -> validation reason

let workspace_fields (workspace : Registry.workspace) =
  [
    ("workspaceId", `String workspace.id);
    ("workspaceName", `String workspace.name);
    ("workspaceRoot", `String workspace.root);
  ]

let cleanup_fields manager ~(caller : Registry.session)
    (session : Registry.session) =
  let created_by_caller =
    Registry.session_created_by manager.Config.registry ~source_id:caller.id
      ~session_id:session.id
  in
  [
    ("createdByCaller", `Bool created_by_caller);
    ( "cleanupRecommended",
      `Bool
        (created_by_caller
        && Registry.cleanup_recommended manager.registry ~source_id:caller.id
             ~session_id:session.id) );
  ]

let runtime_status ~net manager session =
  match Workers.summary ~net manager session with
  | `Assoc fields -> (
      match List.assoc_opt "status" fields with
      | Some (`String value) -> value
      | _ -> "offline")
  | _ -> "offline"

let finished_response ~duplicate target_id =
  Headers.respond_json
    (`Assoc
       [
         ("sessionId", `String target_id);
         ("state", `String "archived");
         ("duplicate", `Bool duplicate);
         ("hardDeleted", `Bool false);
       ])

let handle_broker_finish ~net (manager : Config.managed_workers)
    ~(source : Registry.session) ~request ~read_body =
  match Authentication.valid_json_content request with
  | Error (status, message) ->
      Headers.error_json ~status (authentication_error status message)
  | Ok () -> (
      let json = read_body () |> Yojson.Safe.from_string in
      let open Yojson.Safe.Util in
      let target_id =
        match member "targetSessionId" json with
        | `String value -> value
        | _ -> ""
      in
      if not (Lifecycle.valid_session_id target_id) then
        Headers.error_json
          (validation ~field:"targetSessionId"
             "targetSessionId must be a valid managed session identity")
      else if
        not
          (Registry.session_created_by manager.registry ~source_id:source.id
             ~session_id:target_id)
      then
        Headers.error_json ~status:`Forbidden
          (forbidden
             "only the orchestrator that created this session may finish it")
      else
        match Registry.find manager.registry target_id with
        | None ->
            Headers.error_json
              (Error.Not_found { resource = "created session"; id = target_id })
        | Some { archived_at = Some _; _ } ->
            finished_response ~duplicate:true target_id
        | Some session -> (
            let status = runtime_status ~net manager session in
            if not (Routes.finishable_runtime_status status) then
              Headers.error_json
                (conflict
                   ("session is still " ^ status
                  ^ "; wait for it to become idle before finishing it"))
            else
              match
                Registry.claim_session_finish manager.registry
                  ~source_id:source.id ~session_id:target_id
              with
              | Error message -> Headers.error_json (conflict message)
              | Ok () -> (
                  let fenced_status = runtime_status ~net manager session in
                  if not (Routes.finishable_runtime_status fenced_status) then (
                    ignore
                      (Registry.cancel_session_finish manager.registry target_id);
                    Headers.error_json
                      (conflict
                         ("session became " ^ fenced_status
                        ^ " while cleanup was being fenced; retry after it is \
                           idle")))
                  else
                    match Workers.finish_claimed_session manager target_id with
                    | Ok () -> finished_response ~duplicate:false target_id
                    | Error message -> (
                        match Registry.find manager.registry target_id with
                        | Some { archived_at = Some _; _ } ->
                            finished_response ~duplicate:true target_id
                        | _ -> Headers.error_json (conflict message)))))

let cleanup_guidance session_id =
  `Assoc
    [
      ("sessionId", `String session_id);
      ("tool", `String "piss_finish_session");
      ("when", `String "after all responses are durably collected");
      ("hardDeleted", `Bool false);
    ]

let session_with_workspace (manager : Config.managed_workers)
    (session : Registry.session) =
  let workspace =
    Registry.find_workspace manager.registry session.workspace_id
  in
  match Registry.session_to_yojson session with
  | `Assoc fields ->
      `Assoc
        (fields
        @
        match workspace with
        | None -> []
        | Some workspace -> workspace_fields workspace)
  | _ -> assert false

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
                match session_with_workspace manager session with
                | `Assoc fields ->
                    `Assoc
                      (("self", `Bool (String.equal caller.id session.id))
                       :: cleanup_fields manager ~caller session
                      @ fields)
                | _ -> assert false)
            |> fun sessions -> Headers.respond_json (`List sessions))
  | Routes.Get_broker_workspaces ->
      Some
        (match calling_session with
        | None ->
            Headers.error_json ~status:`Unauthorized
              (forbidden "broker token required")
        | Some caller ->
            let caller_root =
              Registry.find_workspace manager.registry caller.workspace_id
              |> Option.map (fun (workspace : Registry.workspace) ->
                  workspace.root)
            in
            Registry.list_workspaces manager.registry
            |> List.map (fun (workspace : Registry.workspace) ->
                match Registry.workspace_to_yojson workspace with
                | `Assoc fields ->
                    let contains_caller =
                      match caller_root with
                      | None -> false
                      | Some root ->
                          Workspaces.path_within ~root:workspace.root root
                    in
                    `Assoc (("containsCaller", `Bool contains_caller) :: fields)
                | _ -> assert false)
            |> fun workspaces -> Headers.respond_json (`List workspaces))
  | Routes.Post_broker_workspaces ->
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
                let open Yojson.Safe.Util in
                let request_id =
                  match member "requestId" json with
                  | `String value -> value
                  | _ -> ""
                in
                let requested_path =
                  match member "path" json with
                  | `String value -> value
                  | _ -> ""
                in
                if not (Lifecycle.valid_session_id request_id) then
                  Headers.error_json
                    (validation ~field:"requestId"
                       "requestId must contain 3 to 64 lowercase letters, \
                        digits, or hyphens")
                else
                  match Workspaces.canonical_directory requested_path with
                  | None ->
                      Headers.error_json
                        (validation ~field:"path"
                           "Choose an existing local directory")
                  | Some path
                    when not
                           (List.exists
                              (fun root -> Workspaces.path_within ~root path)
                              manager.workspace_discovery_roots) ->
                      Headers.error_json
                        (forbidden
                           "Directory is outside the approved local roots")
                  | Some path -> (
                      match
                        Registry.accept_broker_workspace manager.registry
                          ~id:request_id ~source_id:source.id
                          ~canonical_root:path
                          ~workspace_id:(Workspaces.workspace_id_for_path path)
                          ~name:(Workspaces.workspace_name path)
                      with
                      | Error message -> Headers.error_json (conflict message)
                      | Ok (workspace, duplicate) ->
                          Headers.respond_json
                            ~status:(if duplicate then `OK else `Created)
                            (`Assoc
                               [
                                 ("requestId", `String request_id);
                                 ("duplicate", `Bool duplicate);
                                 ( "workspace",
                                   Registry.workspace_to_yojson workspace );
                               ])))))
  | Routes.Post_broker_sessions ->
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
                let open Yojson.Safe.Util in
                let request_id =
                  match member "requestId" json with
                  | `String value -> value
                  | _ -> ""
                in
                let workspace_id =
                  match member "workspaceId" json with
                  | `String value -> value
                  | _ -> ""
                in
                let title =
                  match member "title" json with
                  | `String value -> value
                  | _ -> ""
                in
                let harness =
                  match member "harness" json with
                  | `String value -> value
                  | _ -> manager.default_harness
                in
                let existed =
                  Option.is_some
                    (Registry.find_session_creation manager.registry request_id)
                in
                match
                  Workers.create_broker_session ~clock manager
                    ~source_id:source.id ~request_id ~harness ~workspace_id
                    ~title
                with
                | Ok (session, duplicate) -> (
                    match
                      Registry.find_workspace manager.registry
                        session.workspace_id
                    with
                    | None ->
                        Headers.error_json
                          (conflict "created session workspace is missing")
                    | Some workspace ->
                        Headers.respond_json
                          ~status:(if duplicate then `OK else `Created)
                          (`Assoc
                             [
                               ("requestId", `String request_id);
                               ("state", `String "active");
                               ("duplicate", `Bool duplicate);
                               ("session", Registry.session_to_yojson session);
                               ( "workspace",
                                 Registry.workspace_to_yojson workspace );
                               ("cleanup", cleanup_guidance session.id);
                             ]))
                | Error message -> (
                    match
                      Registry.find_session_creation manager.registry request_id
                    with
                    | Some creation
                      when String.equal creation.state "failed"
                           && not
                                (String.starts_with ~prefix:"requestId was"
                                   message) ->
                        Headers.respond_json ~status:`Conflict
                          (`Assoc
                             [
                               ("requestId", `String request_id);
                               ("sessionId", `String creation.session_id);
                               ("state", `String "failed");
                               ("duplicate", `Bool existed);
                               ("error", `String message);
                             ])
                    | _ -> Headers.error_json (conflict message)))))
  | Routes.Post_broker_finish ->
      Some
        (match calling_session with
        | None ->
            Headers.error_json ~status:`Unauthorized
              (forbidden "broker token required")
        | Some source ->
            Eio.Mutex.use_ro manager.lifecycle_mutex (fun () ->
                handle_broker_finish ~net manager ~source ~request ~read_body))
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
                           ( "cleanupAfterCollection",
                             `Bool
                               (Registry.session_created_by manager.registry
                                  ~source_id:source.id
                                  ~session_id:peer_request.target_id) );
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
                               ( "cleanupRecommended",
                                 `Bool
                                   (Registry.cleanup_recommended
                                      manager.registry ~source_id:source.id
                                      ~session_id:peer_request.target_id) );
                               ( "cleanup",
                                 cleanup_guidance peer_request.target_id );
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
                  let cleanup_session_ids =
                    finished
                    |> List.filter_map (fun (request : Registry.peer_request) ->
                        if
                          Registry.cleanup_recommended manager.registry
                            ~source_id:source.id ~session_id:request.target_id
                        then Some request.target_id
                        else None)
                    |> List.sort_uniq String.compare
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
                         ( "cleanupRecommendedSessionIds",
                           `List
                             (List.map
                                (fun id -> `String id)
                                cleanup_session_ids) );
                       ])))
  | Routes.Get_workspaces ->
      Some
        ( Registry.list_workspaces manager.registry
        |> List.map Registry.workspace_to_yojson
        |> fun workspaces -> Headers.respond_json (`List workspaces) )
  | Routes.Get_catalog_revision ->
      Some
        (Headers.respond_json
           (`Assoc
              [
                ( "revision",
                  `Intlit
                    (Registry.catalog_revision manager.registry
                    |> Int64.to_string) );
              ]))
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
