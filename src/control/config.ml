(* Control plane configuration: CLI parsing, the workers type, and bootstrap. *)

open Piss_core

type env = {
  workers : workers;
  public_dir : string;
  app_js : string;
  generation : string;
  allowed_users : string list;
  allowed_origins : string list;
  dev_bypass : bool;
}

and managed_workers = {
  registry : Registry.t;
  state_root : string;
  runtime_root : string;
  launcher : string;
  stopper : string;
  available_harnesses : string list;
  default_harness : string;
  mutable default_workspace_id : string;
  workspace_discovery_roots : string list;
  max_active_sessions : int;
  session_locks : Lifecycle.session_locks;
}

and workers = Fixed of string | Managed of managed_workers

let default_max_active_sessions = 32
let max_body_bytes = 16 * 1024 * 1024

(* One stored event may approach the worker's 16 MiB input limit before the
   response envelope is added. Aggregate history pages are bounded
   separately. *)
let max_worker_response_bytes = 32 * 1024 * 1024

let parse () =
  let port = ref 4318 in
  let worker_socket_path = ref "" in
  let registry_path = ref "" in
  let session_state_root = ref "" in
  let session_runtime_root = ref "" in
  let session_launcher = ref "" in
  let session_stopper = ref "" in
  let available_harnesses = ref [] in
  let default_harness = ref "pi" in
  let workspace_specs = ref [] in
  let workspace_discovery_roots = ref [] in
  let bootstrap_session = ref "deployed-tracer" in
  let max_active_sessions = ref default_max_active_sessions in
  let public_dir = ref "web/public" in
  let app_js = ref "web/_build/default/main.bc.js" in
  let generation = ref "development" in
  let allowed_users = ref [] in
  let allowed_origins = ref [] in
  let dev_bypass = ref false in
  Arg.parse
    [
      ("--port", Arg.Set_int port, "Loopback HTTP port");
      ( "--worker-socket",
        Arg.Set_string worker_socket_path,
        "Single worker socket (development compatibility mode)" );
      ("--registry", Arg.Set_string registry_path, "Durable session registry");
      ( "--session-state-root",
        Arg.Set_string session_state_root,
        "Durable per-session state directory" );
      ( "--session-runtime-root",
        Arg.Set_string session_runtime_root,
        "Per-session socket directory" );
      ( "--session-launcher",
        Arg.Set_string session_launcher,
        "Fixed executable used to start a session worker" );
      ( "--session-stopper",
        Arg.Set_string session_stopper,
        "Fixed executable used to stop a session worker" );
      ( "--available-harness",
        Arg.String
          (fun value -> available_harnesses := value :: !available_harnesses),
        "Allowed harness identifier (repeatable)" );
      ( "--default-harness",
        Arg.Set_string default_harness,
        "Harness used by compatibility creation" );
      ( "--workspace-spec",
        Arg.String (fun value -> workspace_specs := value :: !workspace_specs),
        "Allowlisted workspace encoded as id|name|absolute-path (repeatable)" );
      ( "--workspace-discovery-root",
        Arg.String
          (fun value ->
            workspace_discovery_roots := value :: !workspace_discovery_roots),
        "Local root available to the workspace directory picker (repeatable)" );
      ( "--bootstrap-session",
        Arg.Set_string bootstrap_session,
        "Initial session identity for an empty registry" );
      ( "--max-active-sessions",
        Arg.Set_int max_active_sessions,
        "Configured active session resource limit" );
      ("--public", Arg.Set_string public_dir, "Browser public directory");
      ("--app-js", Arg.Set_string app_js, "Browser application JavaScript");
      ( "--generation",
        Arg.Set_string generation,
        "Immutable control-plane generation" );
      ( "--allowed-user",
        Arg.String (fun value -> allowed_users := value :: !allowed_users),
        "Authorized Tailscale login (repeatable)" );
      ( "--allowed-origin",
        Arg.String (fun value -> allowed_origins := value :: !allowed_origins),
        "Accepted Origin URL for state-changing requests (repeatable, e.g. \
         https://piss.tailb61fd1.ts.net)" );
      ( "--dev-bypass-auth",
        Arg.Set dev_bypass,
        "Allow loopback development requests without Tailscale headers" );
    ]
    (fun value -> raise (Arg.Bad ("unexpected argument: " ^ value)))
    "pissd";
  if !allowed_users = [] && not !dev_bypass then
    raise (Arg.Bad "at least one --allowed-user is required");
  if !max_active_sessions < 1 || !max_active_sessions > 256 then
    raise (Arg.Bad "--max-active-sessions must be between 1 and 256");
  let managed_arguments =
    [
      !registry_path;
      !session_state_root;
      !session_runtime_root;
      !session_launcher;
      !session_stopper;
    ]
  in
  let workers, close_registry =
    if !worker_socket_path <> "" then (Fixed !worker_socket_path, fun () -> ())
    else if List.for_all (fun value -> value <> "") managed_arguments then (
      Lifecycle.mkdir_p (Filename.dirname !registry_path);
      Lifecycle.mkdir_p !session_state_root;
      let registry = Registry.open_ ~path:!registry_path in
      let configured_workspaces =
        List.rev !workspace_specs
        |> List.map (fun value ->
            match String.split_on_char '|' value with
            | [ id; name; root ]
              when Lifecycle.valid_session_id id
                   && Lifecycle.valid_title name
                   && not (Filename.is_relative root) ->
                (id, String.trim name, root)
            | _ ->
                raise
                  (Arg.Bad
                     "--workspace-spec must be id|name|absolute-path with a \
                      valid id and name"))
      in
      if configured_workspaces = [] then
        raise (Arg.Bad "--workspace-spec is required");
      List.iter
        (fun (id, name, root) ->
          Registry.configure_workspace registry ~id ~name ~root)
        configured_workspaces;
      let configured_default_id, _, _ = List.hd configured_workspaces in
      let default_workspace_id =
        match Registry.find_workspace registry configured_default_id with
        | Some workspace -> workspace.id
        | None -> (
            match Registry.list_workspaces registry with
            | workspace :: _ -> workspace.id
            | [] -> configured_default_id)
      in
      Registry.assign_unscoped_sessions registry default_workspace_id;
      let available = List.rev !available_harnesses in
      if available = [] then raise (Arg.Bad "--available-harness is required");
      if not (List.exists (String.equal !default_harness) available) then
        raise (Arg.Bad "--default-harness must be available");
      let manager =
        {
          registry;
          state_root = !session_state_root;
          runtime_root = !session_runtime_root;
          launcher = !session_launcher;
          stopper = !session_stopper;
          available_harnesses = available;
          default_harness = !default_harness;
          default_workspace_id;
          workspace_discovery_roots =
            List.rev !workspace_discovery_roots
            |> List.filter_map Workspaces.canonical_directory;
          max_active_sessions = !max_active_sessions;
          session_locks = Lifecycle.create_session_locks ();
        }
      in
      if
        Registry.list registry ~include_archived:true = []
        && Option.is_some
             (Registry.find_workspace registry default_workspace_id)
      then
        ignore
          (Registry.insert registry ~id:!bootstrap_session
             ~title:"Pi / deployed" ~harness:!default_harness
             ~workspace_id:default_workspace_id);
      Registry.list registry ~include_archived:false
      |> List.iter (Lifecycle.write_session_spec registry manager.state_root);
      (Managed manager, fun () -> Registry.close registry))
    else
      raise
        (Arg.Bad
           "provide --worker-socket or the complete managed-session argument \
            set")
  in
  let env =
    {
      workers;
      public_dir = !public_dir;
      app_js = !app_js;
      generation = !generation;
      allowed_users = !allowed_users;
      allowed_origins = !allowed_origins;
      dev_bypass = !dev_bypass;
    }
  in
  (env, close_registry, !port)
