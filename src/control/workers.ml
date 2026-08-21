(* Session registry operations and runtime discovery. *)

open Control_prelude

let canonical_session_workspace (manager : Config.managed_workers)
    (session : Registry.session) =
  match Registry.find_workspace manager.registry session.workspace_id with
  | None -> Error "requested workspace is not registered"
  | Some workspace -> (
      match Workspaces.canonical_directory workspace.root with
      | Some canonical when String.equal canonical workspace.root -> Ok ()
      | None | Some _ ->
          Error
            "registered workspace path no longer resolves to its approved \
             canonical directory")

let start_registered ~process_mgr ~clock (manager : Config.managed_workers) =
  let incomplete_sessions =
    Registry.list_incomplete_session_creations manager.registry
    |> List.map (fun (request : Registry.session_creation) ->
        request.session_id)
  in
  let start (session : Registry.session) =
    try
      match canonical_session_workspace manager session with
      | Ok () -> (
          match
            Lifecycle.run ~process_mgr ~clock manager.launcher session.id
          with
          | Ok () -> ()
          | Error message -> failwith message)
      | Error message -> failwith message
    with exn ->
      Format.eprintf "could not start session %s: %s@." session.id
        (Printexc.to_string exn)
  in
  Eio.Switch.run (fun sw ->
      Registry.list manager.registry ~include_archived:false
      |> List.filter (fun (session : Registry.session) ->
          not (List.mem session.id incomplete_sessions))
      |> List.iter (fun session -> Eio.Fiber.fork ~sw (fun () -> start session)))

let with_session_lock (manager : Config.managed_workers) session_id operation =
  Lifecycle.with_session_lock manager.session_locks session_id operation

let active_session (manager : Config.managed_workers) requested =
  let selected =
    match requested with
    | Some id when Lifecycle.valid_session_id id ->
        Registry.find_active manager.registry id
    | Some _ -> None
    | None ->
        List.nth_opt (Registry.list manager.registry ~include_archived:false) 0
  in
  match selected with
  | Some session -> Ok session
  | None -> Error "active session not found"

let worker_socket (workers : Config.workers) uri =
  match workers with
  | Fixed path -> Ok path
  | Managed manager ->
      let requested = Uri.get_query_param uri "session" in
      Result.map
        (fun (session : Registry.session) ->
          Lifecycle.session_socket manager.runtime_root session.id)
        (active_session manager requested)

let project_waiting_status (manager : Config.managed_workers)
    (session : Registry.session) fields =
  if
    Registry.has_open_peer_work manager.registry ~source_id:session.id
    && List.assoc_opt "status" fields = Some (`String "idle")
  then
    List.map
      (fun (name, value) ->
        if String.equal name "status" then (name, `String "waiting")
        else (name, value))
      fields
  else fields

let snapshot ~net (manager : Config.managed_workers)
    (session : Registry.session) =
  let socket = Lifecycle.session_socket manager.runtime_root session.id in
  Worker_client.request ~net ~socket (`Assoc [ ("op", `String "snapshot") ])
  |> Result.map (function
    | `Assoc fields -> `Assoc (project_waiting_status manager session fields)
    | value -> value)

let summary_json (session : Registry.session) runtime =
  match Registry.session_to_yojson session with
  | `Assoc fields -> `Assoc (fields @ runtime)
  | _ -> assert false

let offline_summary session =
  summary_json session [ ("status", `String "offline") ]

let summary ~net (manager : Config.managed_workers) (session : Registry.session)
    =
  try
    match snapshot ~net manager session with
    | Ok (`Assoc fields) -> summary_json session fields
    | Ok _ | Error _ -> offline_summary session
  with _ -> offline_summary session

let max_parallel_summaries = 8
let summary_timeout_seconds = 1.

let summaries ~net ~clock manager sessions =
  Parallel_map.map_with_timeout ~clock ~timeout_seconds:summary_timeout_seconds
    ~max_fibers:max_parallel_summaries ~on_timeout:offline_summary
    (summary ~net manager) sessions

let fail_session_creation ~process_mgr ~clock (manager : Config.managed_workers)
    (request : Registry.session_creation) message =
  ignore
    (Registry.mark_session_creation_cleanup manager.registry request.id message);
  match
    Lifecycle.run ~process_mgr ~clock manager.stopper request.session_id
  with
  | Error cleanup -> Error (message ^ "; worker cleanup pending: " ^ cleanup)
  | Ok () ->
      ignore (Registry.archive manager.registry request.session_id);
      ignore
        (Registry.mark_session_creation_failed manager.registry request.id
           message);
      Error message

let launch_session_creation ~process_mgr ~clock
    (manager : Config.managed_workers) (request : Registry.session_creation)
    (session : Registry.session) =
  try
    (match canonical_session_workspace manager session with
    | Ok () -> ()
    | Error message -> raise (Failure message));
    Lifecycle.write_session_spec manager.registry manager.state_root session;
    match Lifecycle.run ~process_mgr ~clock manager.launcher session.id with
    | Error message ->
        fail_session_creation ~process_mgr ~clock manager request message
    | Ok () -> (
        match Registry.find_active manager.registry session.id with
        | None ->
            fail_session_creation ~process_mgr ~clock manager request
              "session was archived while its worker was starting"
        | Some active ->
            ignore
              (Registry.mark_session_creation_active manager.registry request.id);
            Ok active)
  with exn ->
    fail_session_creation ~process_mgr ~clock manager request
      (Printexc.to_string exn)

let rec wait_for_session_creation ~clock (manager : Config.managed_workers)
    ~deadline ~duplicate request session =
  match Registry.find_session_creation manager.registry request.Registry.id with
  | None -> Error "session creation request disappeared"
  | Some { state = Registry_domain.Session_creation_state.Active; _ } ->
      Ok (session, duplicate)
  | Some
      ({ state = Registry_domain.Session_creation_state.Failed; _ } as current)
    ->
      Error (Option.value current.error ~default:"session launcher failed")
  | Some _ when Unix.gettimeofday () >= deadline ->
      Error "session creation is still being reconciled"
  | Some _ ->
      Eio.Time.sleep clock 0.05;
      wait_for_session_creation ~clock manager ~deadline ~duplicate request
        session

let create_broker_session ~process_mgr ~clock (manager : Config.managed_workers)
    ~source_id ~request_id ~harness ~workspace_id ~title ~model =
  let title = String.trim title in
  if not (Lifecycle.valid_session_id request_id) then
    Error "requestId must contain 3 to 64 lowercase letters, digits, or hyphens"
  else if not (List.exists (String.equal harness) manager.available_harnesses)
  then Error "requested harness is not available"
  else if not (Lifecycle.valid_title title) then
    Error "title must contain between 1 and 120 characters"
  else if
    match Registry.find_workspace manager.registry workspace_id with
    | None -> true
    | Some workspace -> (
        match Workspaces.canonical_directory workspace.root with
        | Some canonical -> not (String.equal canonical workspace.root)
        | None -> true)
  then Error "registered workspace path is no longer canonical"
  else
    let session_id = Lifecycle.random_session_id () in
    match
      Registry.accept_session_creation manager.registry ~id:request_id
        ~source_id ~workspace_id ~title ~harness ~session_id
        ~max_active_sessions:manager.max_active_sessions
    with
    | Error _ as error -> error
    | Ok (request, session, duplicate) ->
        if Registry.claim_session_creation manager.registry request.id then (
          (match model with
          | "" -> ()
          | _ ->
              Lifecycle.write_session_model_spec manager.state_root session
                model);
          Result.map
            (fun active -> (active, duplicate))
            (launch_session_creation ~process_mgr ~clock manager request session))
        else
          wait_for_session_creation ~clock manager
            ~deadline:(Unix.gettimeofday () +. 65.)
            ~duplicate request session

let reconcile_session_creations ?(recover_launching = true) ~process_mgr ~clock
    (manager : Config.managed_workers) =
  Registry.list_incomplete_session_creations manager.registry
  |> List.iter (fun (request : Registry.session_creation) ->
      match
        (request.state, Registry.find manager.registry request.session_id)
      with
      | Registry_domain.Session_creation_state.Cleanup, Some _ -> (
          match
            Lifecycle.run ~process_mgr ~clock manager.stopper request.session_id
          with
          | Error message ->
              Format.eprintf "could not finish session cleanup %s: %s@."
                request.session_id message
          | Ok () ->
              ignore (Registry.archive manager.registry request.session_id);
              ignore
                (Registry.mark_session_creation_failed manager.registry
                   request.id
                   (Option.value request.error
                      ~default:"session launcher failed")))
      | _, None ->
          ignore
            (Registry.mark_session_creation_failed manager.registry request.id
               "reserved session metadata is missing")
      | _, Some { archived_at = Some _; _ } ->
          ignore
            (Registry.mark_session_creation_failed manager.registry request.id
               "reserved session was archived before launch completed")
      | _, Some session ->
          if
            recover_launching
            && Registry.claim_session_creation
                 ~reclaim_before:(Unix.gettimeofday () +. 1.)
                 manager.registry request.id
          then
            ignore
              (launch_session_creation ~process_mgr ~clock manager request
                 session))

let create_managed_session ~process_mgr ~clock
    (manager : Config.managed_workers) ~harness ~workspace_id ~title =
  if not (List.exists (String.equal harness) manager.available_harnesses) then
    Error "requested harness is not available"
  else if Option.is_none (Registry.find_workspace manager.registry workspace_id)
  then Error "requested workspace is not registered"
  else if
    match Registry.find_workspace manager.registry workspace_id with
    | None -> true
    | Some workspace -> (
        match Workspaces.canonical_directory workspace.root with
        | Some canonical -> not (String.equal canonical workspace.root)
        | None -> true)
  then Error "registered workspace path is no longer canonical"
  else if not (Lifecycle.valid_title title) then
    Error "title must contain between 1 and 120 characters"
  else if Registry.active_count manager.registry >= manager.max_active_sessions
  then Error "active session limit reached"
  else
    let id = Lifecycle.random_session_id () in
    let session =
      Registry.insert manager.registry ~id ~title:(String.trim title) ~harness
        ~workspace_id
    in
    let abort_creation message =
      (* A launcher can time out while its supervised worker is still starting.
         Stop before archiving so a failed create never leaves a hidden worker
         running for a session omitted from the active catalog. *)
      ignore (Lifecycle.run ~process_mgr ~clock manager.stopper id);
      ignore (Registry.archive manager.registry id);
      Error message
    in
    try
      Lifecycle.write_session_spec manager.registry manager.state_root session;
      match Lifecycle.run ~process_mgr ~clock manager.launcher id with
      | Ok () -> Ok session
      | Error message -> abort_creation message
    with exn -> abort_creation (Printexc.to_string exn)

let finish_claimed_session ~process_mgr ~clock
    (manager : Config.managed_workers) id =
  match Lifecycle.run ~process_mgr ~clock manager.stopper id with
  | Error message ->
      ignore (Registry.cancel_session_finish manager.registry id);
      Error message
  | Ok () ->
      if Registry.archive manager.registry id then Ok ()
      else (
        ignore (Registry.cancel_session_finish manager.registry id);
        Error "session was already archived")

let reconcile_session_finishes ~process_mgr ~clock
    (manager : Config.managed_workers) =
  Registry.list_finishing_sessions manager.registry
  |> List.iter (fun (session : Registry.session) ->
      with_session_lock manager session.id (fun () ->
          let still_finishing =
            Registry.list_finishing_sessions manager.registry
            |> List.exists (fun (current : Registry.session) ->
                String.equal current.id session.id)
          in
          if still_finishing then
            match
              Lifecycle.run ~process_mgr ~clock manager.stopper session.id
            with
            | Ok () ->
                if not (Registry.archive manager.registry session.id) then
                  Format.eprintf "could not archive reconciled session %s@."
                    session.id
            | Error message ->
                ignore
                  (Registry.cancel_session_finish manager.registry session.id);
                Format.eprintf
                  "could not reconcile session finish %s; restored it to \
                   active: %s@."
                  session.id message))

let archive_managed_session ~process_mgr ~clock
    (manager : Config.managed_workers) id =
  with_session_lock manager id (fun () ->
      match Registry.find_active manager.registry id with
      | None -> Error "active session not found"
      | Some _ -> (
          match Lifecycle.run ~process_mgr ~clock manager.stopper id with
          | Error message -> Error message
          | Ok () ->
              if Registry.archive manager.registry id then Ok ()
              else Error "session was already archived"))

let delete_archived_sessions ?ids (manager : Config.managed_workers) =
  let archived = Registry.list_archived manager.registry in
  let selected =
    match ids with
    | None -> archived
    | Some ids ->
        List.filter
          (fun (session : Registry.session) -> List.mem session.id ids)
          archived
  in
  if
    match ids with
    | Some requested -> List.length requested <> List.length selected
    | None -> false
  then Error "one or more selected sessions are not archived"
  else
    match
      List.find_opt
        (fun (session : Registry.session) ->
          not (Lifecycle.valid_session_id session.id))
        selected
    with
    | Some _ -> Error "archived session has an invalid identity"
    | None -> (
        try
          List.iter
            (fun (session : Registry.session) ->
              Lifecycle.remove_tree
                (Filename.concat manager.state_root session.id);
              Lifecycle.remove_tree
                (Filename.concat manager.runtime_root session.id))
            selected;
          let selected_ids =
            List.map (fun (session : Registry.session) -> session.id) selected
          in
          Ok (Registry.delete_archived_ids manager.registry selected_ids)
        with exn -> Error (Printexc.to_string exn))

let restore_managed_session ~process_mgr ~clock
    (manager : Config.managed_workers) id =
  with_session_lock manager id (fun () ->
      (* TODO(tracer): Persist started/completed lifecycle receipts before
         replacing the local synchronous systemd launcher with a remote or
         queued launcher. *)
      match Registry.find manager.registry id with
      | None -> Error "archived session not found"
      | Some { archived_at = None; _ } -> Error "session is already active"
      | Some session -> (
          match canonical_session_workspace manager session with
          | Error message -> Error message
          | Ok () -> (
              if
                Registry.active_count manager.registry
                >= manager.max_active_sessions
              then Error "active session limit reached"
              else if not (Registry.restore manager.registry id) then
                Error "session could not be restored"
              else
                try
                  Lifecycle.write_session_spec manager.registry
                    manager.state_root
                    { session with archived_at = None };
                  match
                    Lifecycle.run ~process_mgr ~clock manager.launcher id
                  with
                  | Ok () -> Ok ()
                  | Error message ->
                      ignore (Registry.archive manager.registry id);
                      Error message
                with exn ->
                  ignore (Registry.archive manager.registry id);
                  Error (Printexc.to_string exn))))
