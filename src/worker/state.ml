(* Mutable runtime state for one session worker. *)

open Piss_core

type t = {
  args : Config.args;
  store : Store.t;
  workspace : string;
  harness_pid : int;
  runtime_worker_id : string;
  runtime_generation : int;
  agent_name : string ref;
  supports_load : bool ref;
  supports_images : bool ref;
  harness_session_id : string ref;
  config_options : Yojson.Safe.t ref;
  status : Domain.worker_status ref;
  harness_running : bool ref;
  running_commands : (string, float) Hashtbl.t;
  pending_permissions : (string, Config.pending_permission) Hashtbl.t;
  configuration_changes : int ref;
  upgrade_target : string option ref;
  upgrade_deadline : float ref;
  sessions_created_since_start : int ref;
  send : Yojson.Safe.t -> unit;
  require_rpc_result :
    id:string -> Yojson.Safe.t -> Yojson.Safe.t * Yojson.Safe.t;
}

let make ~args ~store ~workspace ~harness_pid ~runtime_worker_id
    ~runtime_generation ~send ~require_rpc_result =
  {
    args;
    store;
    workspace;
    harness_pid;
    runtime_worker_id;
    runtime_generation;
    agent_name = ref "ACP agent";
    supports_load = ref false;
    supports_images = ref false;
    harness_session_id = ref "";
    config_options = ref (`List []);
    status = ref Domain.Starting;
    harness_running = ref false;
    running_commands = Hashtbl.create 4;
    pending_permissions = Hashtbl.create 8;
    configuration_changes = ref 0;
    upgrade_target = ref None;
    upgrade_deadline = ref 0.;
    sessions_created_since_start = ref 0;
    send;
    require_rpc_result;
  }

let args t = t.args
let store t = t.store
let workspace t = t.workspace
let runtime_worker_id t = t.runtime_worker_id

let runtime_target t =
  Domain.
    {
      session_id = session_id t.args.session_id;
      worker_id = worker_id t.runtime_worker_id;
      runtime_generation = runtime_generation t.runtime_generation;
    }

let initialize_agent t ~name ~supports_load ~supports_images =
  t.agent_name := name;
  t.supports_load := supports_load;
  t.supports_images := supports_images

let supports_images t = !(t.supports_images)
let status t = !(t.status)
let set_status t status = t.status := status

let snapshot t =
  let first_sequence = Store.first_retained_sequence t.store in
  let last_sequence = Store.last_sequence t.store in
  let last_finished_at = Store.last_finished_at t.store in
  let retention_pruned =
    (last_sequence > 0L && first_sequence > 1L)
    ||
    match Store.get_metadata t.store "retention_pruned" with
    | Some value when String.equal value "true" -> true
    | _ -> false
  in
  if retention_pruned then Store.set_metadata t.store "retention_pruned" "true";
  Domain.
    {
      session_id = session_id t.args.session_id;
      worker_id = worker_id t.runtime_worker_id;
      runtime_generation = runtime_generation t.runtime_generation;
      worker_pid = Unix.getpid ();
      harness_pid = Some t.harness_pid;
      agent_name = !(t.agent_name);
      status = !(t.status);
      first_sequence;
      last_sequence;
      last_finished_at;
      retention_pruned;
    }

let harness_session_id t = !(t.harness_session_id)
let set_harness_session_id t session_id = t.harness_session_id := session_id
let config_options t = !(t.config_options)
let set_config_options t options = t.config_options := options

let selected_config_values t =
  match !(t.config_options) with
  | `List options ->
      `Assoc
        (List.filter_map
           (fun option ->
             match
               ( Yojson.Safe.Util.member "id" option,
                 Yojson.Safe.Util.member "currentValue" option )
             with
             | `String id, `String value -> Some (id, `String value)
             | _ -> None)
           options)
  | _ -> `Assoc []

let persist_config_values t =
  Store.set_metadata t.store "config_option_values"
    (Yojson.Safe.to_string (selected_config_values t))

let install_config_options_from_result t result =
  match Yojson.Safe.Util.member "configOptions" result with
  | `List _ as options -> set_config_options t options
  | _ -> ()

let create_harness_session t =
  let result, response =
    t.require_rpc_result ~id:"session-new"
      (Acp.new_session_request ~cwd:t.workspace ~session_id:t.args.session_id
         ~mcp_command:t.args.session_mcp ~broker_url:t.args.broker_url
         ~broker_token:t.args.broker_token ~curl_command:t.args.curl_command)
  in
  let created =
    match Yojson.Safe.Util.member "sessionId" result with
    | `String value -> value
    | _ -> raise (Failure "ACP agent did not return a sessionId")
  in
  Store.set_metadata t.store "acp_session_id" created;
  install_config_options_from_result t result;
  ignore
    (Store.append_event t.store ~kind:"acp.session.created" ~payload:response);
  created

let record_additional_session t ~session_id =
  set_harness_session_id t session_id;
  incr t.sessions_created_since_start;
  ignore
    (Store.append_event t.store ~kind:"timeline.reset"
       ~payload:(`Assoc [ ("acpSessionId", `String session_id) ]));
  (* A newly selected ACP session starts idle. Late updates from the previous
     session are filtered by session id in the worker reader. *)
  t.harness_running := false;
  set_status t Domain.Idle

let additional_session_limit_reached t = !(t.sessions_created_since_start) >= 4

let current_config_value t ~config_id =
  match !(t.config_options) with
  | `List options ->
      List.find_map
        (fun option ->
          match
            ( Yojson.Safe.Util.member "id" option,
              Yojson.Safe.Util.member "currentValue" option )
          with
          | `String id, `String current when id = config_id -> Some current
          | _ -> None)
        options
  | _ -> None

let change_config_option t ~id ~config_id ~value =
  incr t.configuration_changes;
  let result, response =
    Fun.protect
      ~finally:(fun () -> decr t.configuration_changes)
      (fun () ->
        t.require_rpc_result ~id
          (Acp.set_config_option_request ~id ~session_id:(harness_session_id t)
             ~config_id ~value))
  in
  install_config_options_from_result t result;
  persist_config_values t;
  (result, response)

let recompute_status t =
  set_status t
    (if Hashtbl.length t.pending_permissions > 0 then Domain.Requires_action
     else if !(t.harness_running) || Hashtbl.length t.running_commands > 0 then
       Domain.Running
     else Domain.Idle)

let set_harness_running t running =
  t.harness_running := running;
  recompute_status t

let refresh_status t = recompute_status t
let harness_running t = !(t.harness_running)
let runtime_busy t = harness_running t || Hashtbl.length t.running_commands > 0

let record_dispatched t ~command_id =
  set_status t Domain.Running;
  Store.set_command_state t.store ~command_id Domain.Dispatched;
  Hashtbl.replace t.running_commands command_id (Unix.gettimeofday ())

let record_dispatch_failed t ~command_id =
  Hashtbl.remove t.running_commands command_id;
  Store.set_command_state t.store ~command_id Domain.Ambiguous;
  set_status t Domain.Failed

let record_completed t ~command_id ~state =
  Hashtbl.remove t.running_commands command_id;
  Store.set_command_state t.store ~command_id state;
  recompute_status t

let is_running_command t ~command_id = Hashtbl.mem t.running_commands command_id
let running_command_count t = Hashtbl.length t.running_commands
let pending_permission_count t = Hashtbl.length t.pending_permissions
let configuration_change_depth t = !(t.configuration_changes)

let record_pending_permission t ~request_id ~raw_id ~params =
  Hashtbl.replace t.pending_permissions request_id
    { Config.raw_id; params; requested_at = Unix.gettimeofday () };
  set_status t Domain.Requires_action

let pending_permission t ~request_id =
  Hashtbl.find_opt t.pending_permissions request_id

let resolve_permission t ~request_id =
  Hashtbl.remove t.pending_permissions request_id;
  recompute_status t

let cancel_permission t ~request_id =
  if Hashtbl.mem t.pending_permissions request_id then (
    resolve_permission t ~request_id;
    true)
  else false

let expire_stuck_permissions t ~now =
  let stuck =
    Hashtbl.fold
      (fun request_id permission acc ->
        if
          now -. permission.Config.requested_at
          > Config.permission_timeout_seconds
        then (request_id, permission) :: acc
        else acc)
      t.pending_permissions []
  in
  List.iter
    (fun (request_id, permission) ->
      Hashtbl.remove t.pending_permissions request_id;
      ignore
        (Store.append_event t.store ~kind:"acp.permission.expired"
           ~payload:
             (`Assoc
                [
                  ("requestId", `String request_id);
                  ("timeoutSeconds", `Float Config.permission_timeout_seconds);
                  ( "reason",
                    `String
                      "user did not respond to the permission request within \
                       the configured budget; the worker is replying with \
                       cancelled on the user's behalf" );
                ]));
      t.send
        (Acp.response_with_id ~id:permission.Config.raw_id
           (`Assoc [ ("outcome", `Assoc [ ("outcome", `String "cancelled") ]) ])))
    stuck;
  if stuck <> [] then recompute_status t

let send t json = t.send json

let refresh_upgrade_lease t =
  match !(t.upgrade_target) with
  | Some target when Unix.gettimeofday () >= !(t.upgrade_deadline) ->
      t.upgrade_target := None;
      t.upgrade_deadline := 0.;
      Store.set_metadata t.store "pending_worker_upgrade" "";
      ignore
        (Store.append_event t.store ~kind:"worker.upgrade.expired"
           ~payload:(`Assoc [ ("targetGeneration", `String target) ]))
  | _ -> ()

let start_upgrade t ~target ~deadline =
  t.upgrade_target := Some target;
  t.upgrade_deadline := deadline;
  persist_config_values t;
  Store.set_metadata t.store "pending_worker_upgrade" target;
  Store.append_event t.store ~kind:"worker.upgrade.prepared"
    ~payload:
      (`Assoc
         [
           ("fromGeneration", `String t.args.generation);
           ("toGeneration", `String target);
           ("leaseSeconds", `Int 30);
         ])

let upgrade_is_preparing t =
  refresh_upgrade_lease t;
  Option.is_some !(t.upgrade_target)
