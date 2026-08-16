(* Session registry operations and runtime discovery. *)

open Piss_core

let start_registered ~process_mgr (manager : Config.managed_workers) =
  let start (session : Registry.session) =
    try Eio.Process.run process_mgr [ manager.launcher; session.id ]
    with exn ->
      Format.eprintf "could not start session %s: %s@." session.id
        (Printexc.to_string exn)
  in
  Eio.Switch.run (fun sw ->
      Registry.list manager.registry ~include_archived:false
      |> List.iter (fun session -> Eio.Fiber.fork ~sw (fun () -> start session)))

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

let summary ~net (manager : Config.managed_workers) (session : Registry.session)
    =
  let runtime =
    try
      match snapshot ~net manager session with
      | Ok (`Assoc fields) -> fields
      | Ok _ -> []
      | Error _ -> [ ("status", `String "offline") ]
    with _ -> [ ("status", `String "offline") ]
  in
  match Registry.session_to_yojson session with
  | `Assoc fields -> `Assoc (fields @ runtime)
  | _ -> assert false

let create_managed_session (manager : Config.managed_workers) ~harness
    ~workspace_id ~title =
  if not (List.exists (String.equal harness) manager.available_harnesses) then
    Error "requested harness is not available"
  else if Option.is_none (Registry.find_workspace manager.registry workspace_id)
  then Error "requested workspace is not registered"
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
      ignore (Lifecycle.run manager.stopper id);
      ignore (Registry.archive manager.registry id);
      Error message
    in
    try
      Lifecycle.write_session_spec manager.registry manager.state_root session;
      match Lifecycle.run manager.launcher id with
      | Ok () -> Ok session
      | Error message -> abort_creation message
    with exn -> abort_creation (Printexc.to_string exn)

let archive_managed_session (manager : Config.managed_workers) id =
  match Registry.find_active manager.registry id with
  | None -> Error "active session not found"
  | Some _ -> (
      match Lifecycle.run manager.stopper id with
      | Error message -> Error message
      | Ok () ->
          if Registry.archive manager.registry id then Ok ()
          else Error "session was already archived")

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

let restore_managed_session (manager : Config.managed_workers) id =
  (* TODO(tracer): Persist started/completed lifecycle receipts before replacing
     the local synchronous systemd launcher with a remote or queued launcher. *)
  match Registry.find manager.registry id with
  | None -> Error "archived session not found"
  | Some { archived_at = None; _ } -> Error "session is already active"
  | Some session -> (
      if Registry.active_count manager.registry >= manager.max_active_sessions
      then Error "active session limit reached"
      else if not (Registry.restore manager.registry id) then
        Error "session could not be restored"
      else
        try
          Lifecycle.write_session_spec manager.registry manager.state_root
            { session with archived_at = None };
          match Lifecycle.run manager.launcher id with
          | Ok () -> Ok ()
          | Error message ->
              ignore (Registry.archive manager.registry id);
              Error message
        with exn ->
          ignore (Registry.archive manager.registry id);
          Error (Printexc.to_string exn))
