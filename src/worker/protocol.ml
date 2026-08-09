(* Worker wire protocol: request handlers for the Unix-domain socket. *)

open Piss_core

type t = {
  args : Config.args;
  store : Store.t;
  workspace : string;
  agent_name : string;
  supports_load : bool;
  supports_images : bool;
  harness_session_id : string ref;
  config_options : Yojson.Safe.t ref;
  status : Domain.worker_status ref;
  running_commands : (string, float) Hashtbl.t;
  pending_permissions : (string, Config.pending_permission) Hashtbl.t;
  configuration_changes : int ref;
  upgrade_target : string option ref;
  upgrade_deadline : float ref;
  sessions_created_since_start : int ref;
  send : Yojson.Safe.t -> unit;
  persist_config_values : unit -> unit;
  create_session : unit -> string;
  require_rpc_result :
    id:string -> Yojson.Safe.t -> Yojson.Safe.t * Yojson.Safe.t;
}

let worker_snapshot (state : t) =
  let first_sequence = Store.first_retained_sequence state.store in
  let last_sequence = Store.last_sequence state.store in
  let retention_pruned =
    (last_sequence > 0L && first_sequence > 1L)
    ||
    match Store.get_metadata state.store "retention_pruned" with
    | Some value when String.equal value "true" -> true
    | _ -> false
  in
  if retention_pruned then
    Store.set_metadata state.store "retention_pruned" "true";
  Domain.
    {
      session_id = Session_id state.args.session_id;
      worker_id = Worker_id state.args.worker_id;
      runtime_generation = Runtime_generation 1;
      worker_pid = Unix.getpid ();
      harness_pid = None;
      agent_name = state.agent_name;
      status = !(state.status);
      first_sequence;
      last_sequence;
      retention_pruned;
    }

let refresh_upgrade_lease (state : t) =
  match !(state.upgrade_target) with
  | Some target when Unix.gettimeofday () >= !(state.upgrade_deadline) ->
      state.upgrade_target := None;
      state.upgrade_deadline := 0.;
      Store.set_metadata state.store "pending_worker_upgrade" "";
      ignore
        (Store.append_event state.store ~kind:"worker.upgrade.expired"
           (`Assoc [ ("targetGeneration", `String target) ]))
  | _ -> ()

let upgrade_preparing state =
  refresh_upgrade_lease state;
  Option.is_some !(state.upgrade_target)

let resolve_resources ~workspace resources =
  List.fold_left
    (fun resolved (resource : Domain.resource_input) ->
      Result.bind resolved (fun resources ->
          Workspace_io.resolve_resource ~root:workspace resource.path
          |> Result.map (fun value -> value :: resources)))
    (Ok []) resources
  |> Result.map List.rev

let resource_metadata (resource : Workspace_files.resource) =
  `Assoc
    ([
       ("path", `String resource.path);
       ("name", `String resource.name);
       ("size", `Int resource.size);
     ]
    @
    match resource.mime_type with
    | Some value -> [ ("mimeType", `String value) ]
    | None -> [])

let dispatch_prompt (state : t) ?action ~command_id ~text ~images ~resources ()
    =
  match resolve_resources ~workspace:state.workspace resources with
  | Error message -> Error message
  | Ok resolved_resources -> (
      let image_metadata = List.map Wire.image_metadata_to_yojson images in
      let resources_metadata = List.map resource_metadata resolved_resources in
      let content =
        `List
          (List.map Wire.image_to_yojson images
          @ List.map Wire.resource_to_yojson resources)
      in
      let accepted =
        Store.accept_command ?action state.store ~content ~images:image_metadata
          ~resources:resources_metadata ~command_id ~request_id:command_id
          ~prompt:text
      in
      try
        state.status := Domain.Running;
        Store.set_command_state state.store ~command_id Domain.Dispatched;
        Hashtbl.replace state.running_commands command_id (Unix.gettimeofday ());
        state.send
          (Acp.prompt_request ~delivery:action ~command_id
             ~session_id:!(state.harness_session_id)
             ~text ~images ~resources:resolved_resources);
        Store.clear_command_content state.store ~command_id;
        Ok
          (`Assoc
             ([
                ("commandId", `String command_id);
                ("state", `String "dispatched");
                ("duplicate", `Bool accepted.duplicate);
              ]
             @
             match action with
             | Some value -> [ ("action", `String value) ]
             | None -> []))
      with exn ->
        state.status := Domain.Failed;
        Store.set_command_state state.store ~command_id Domain.Ambiguous;
        Error (Printexc.to_string exn))

let handle (state : t) request =
  match request with
  | Wire.Hello { protocol_version = 1 } ->
      Ok
        (`Assoc
           [
             ("protocolVersion", `Int 1);
             ("workerId", `String state.args.worker_id);
             ( "capabilities",
               `List
                 ([
                    `String "events";
                    `String "prompt";
                    `String "steer";
                    `String "follow_up";
                    `String "cancel";
                    `String "permission";
                    `String "config_options";
                  ]
                 @
                 if state.supports_images then [ `String "image_prompt" ]
                 else []) );
           ])
  | Wire.Hello { protocol_version } ->
      Error
        (Printf.sprintf "unsupported worker protocol version %d"
           protocol_version)
  | Wire.Snapshot -> (
      let snapshot = Domain.snapshot_to_yojson (worker_snapshot state) in
      match snapshot with
      | `Assoc fields ->
          Ok
            (`Assoc
               (("workerGeneration", `String state.args.generation)
               :: ("upgradePending", `Bool (upgrade_preparing state))
               :: ("acceptsImages", `Bool state.supports_images)
               :: ("configOptions", !(state.config_options))
               :: fields))
      | _ -> assert false)
  | Wire.Prepare_upgrade { generation = target }
    when String.equal target state.args.generation ->
      Ok
        (`Assoc
           [
             ("ready", `Bool false);
             ("alreadyCurrent", `Bool true);
             ("generation", `String state.args.generation);
           ])
  | Wire.Prepare_upgrade { generation = target } ->
      refresh_upgrade_lease state;
      if
        Hashtbl.length state.running_commands > 0
        || Hashtbl.length state.pending_permissions > 0
        || !(state.configuration_changes) > 0
        || !(state.status) <> Domain.Idle
      then Error "worker is not idle and cannot prepare for upgrade"
      else (
        state.upgrade_target := Some target;
        state.upgrade_deadline := Unix.gettimeofday () +. 30.;
        state.persist_config_values ();
        Store.set_metadata state.store "pending_worker_upgrade" target;
        let event =
          Store.append_event state.store ~kind:"worker.upgrade.prepared"
            (`Assoc
               [
                 ("fromGeneration", `String state.args.generation);
                 ("toGeneration", `String target);
                 ("leaseSeconds", `Int 30);
               ])
        in
        Ok
          (`Assoc
             [
               ("ready", `Bool true);
               ("alreadyCurrent", `Bool false);
               ("generation", `String state.args.generation);
               ("targetGeneration", `String target);
               ("sequence", `Intlit (Int64.to_string event.sequence));
             ]))
  | Wire.Events { after; limit } ->
      let events = Store.list_events state.store ~after ~limit in
      Ok (`List (List.map Domain.event_to_yojson events))
  | Wire.Events_before { before; limit } ->
      let events = Store.list_events_before state.store ~before ~limit in
      Ok (`List (List.map Domain.event_to_yojson events))
  | Wire.Recent_events { limit } ->
      let events = Store.list_recent_events state.store ~limit in
      Ok (`List (List.map Domain.event_to_yojson events))
  | Wire.File_search { query } ->
      Workspace_io.search ~root:state.workspace ~query
      |> Result.map (fun mentions ->
          `List (List.map Workspace_files.mention_to_yojson mentions))
  | Wire.Config_options -> Ok !(state.config_options)
  | _ when upgrade_preparing state ->
      Error "worker is preparing for an immutable generation upgrade"
  | Wire.New_session ->
      if
        Hashtbl.length state.running_commands > 0
        || Hashtbl.length state.pending_permissions > 0
      then Error "the active session must be idle before creating another"
      else if !(state.sessions_created_since_start) >= 4 then
        (* TODO(tracer): Replace this in-adapter cap with one independently
           supervised worker per durable session before exposing unbounded
           session creation. pi-acp retains a Pi process for every session. *)
        Error "restart the worker before creating more than four sessions"
      else (
        state.status := Domain.Starting;
        let created = state.create_session () in
        state.harness_session_id := created;
        incr state.sessions_created_since_start;
        ignore
          (Store.append_event state.store ~kind:"timeline.reset"
             (`Assoc [ ("acpSessionId", `String created) ]));
        state.status := Domain.Idle;
        Ok (`Assoc [ ("sessionId", `String created) ]))
  | Wire.Prompt { images; _ } when images <> [] && not state.supports_images ->
      Error "the ACP agent does not accept image prompts"
  | Wire.Prompt { command_id; text; images; resources } -> (
      match Store.find_command state.store command_id with
      | Some state ->
          Ok
            (`Assoc
               [
                 ("commandId", `String command_id);
                 ("state", `String (Domain.command_state_to_string state));
                 ("duplicate", `Bool true);
               ])
      | None when Hashtbl.length state.running_commands > 0 ->
          Error "the session already has an active prompt"
      | None -> dispatch_prompt state ~command_id ~text ~images ~resources ())
  | Wire.Deliver { images; _ } when images <> [] && not state.supports_images ->
      Error "the ACP agent does not accept image prompts"
  | Wire.Deliver { command_id; text; images; resources; action } -> (
      match Store.find_command state.store command_id with
      | Some state ->
          Ok
            (`Assoc
               [
                 ("commandId", `String command_id);
                 ("state", `String (Domain.command_state_to_string state));
                 ("duplicate", `Bool true);
               ])
      | None when Hashtbl.length state.running_commands = 0 ->
          Error (action ^ " is only available during an active prompt")
      | None ->
          dispatch_prompt state ~action ~command_id ~text ~images ~resources ())
  | Wire.Set_config_option { config_id; value } ->
      if
        Hashtbl.length state.running_commands > 0
        || Hashtbl.length state.pending_permissions > 0
      then Error "session configuration can only change while idle"
      else
        let id =
          "config-"
          ^ Digest.to_hex
              (Digest.string
                 (config_id ^ "\000" ^ value ^ "\000"
                 ^ string_of_float (Unix.gettimeofday ())))
        in
        let result, response =
          incr state.configuration_changes;
          Fun.protect
            ~finally:(fun () -> decr state.configuration_changes)
            (fun () ->
              state.require_rpc_result ~id
                (Acp.set_config_option_request ~id
                   ~session_id:!(state.harness_session_id)
                   ~config_id ~value))
        in
        (match Yojson.Safe.Util.member "configOptions" result with
        | `List _ as options -> state.config_options := options
        | _ -> ());
        state.persist_config_values ();
        ignore
          (Store.append_event state.store ~kind:"acp.config_option.changed"
             response);
        Ok (`Assoc [ ("configOptions", !(state.config_options)) ])
  | Wire.Cancel ->
      if Hashtbl.length state.running_commands = 0 then
        Error "the session has no active prompt"
      else (
        ignore
          (Store.append_event state.store ~kind:"command.cancel.requested"
             (`Assoc [ ("sessionId", `String !(state.harness_session_id)) ]));
        state.send
          (Acp.cancel_notification ~session_id:!(state.harness_session_id));
        Ok (`Assoc [ ("state", `String "cancelling") ]))
  | Wire.Peer_event { kind; request_id; peer_id; text } ->
      let event =
        Store.append_event state.store ~kind
          (`Assoc
             [
               ("requestId", `String request_id);
               ("peerId", `String peer_id);
               ("text", `String text);
             ])
      in
      Ok (Domain.event_to_yojson event)
  | Wire.Permission { request_id; option_id } -> (
      match Hashtbl.find_opt state.pending_permissions request_id with
      | None -> Error "permission request is no longer pending"
      | Some permission -> (
          match option_id with
          | Some selected
            when not (Harness.option_is_offered permission.params selected) ->
              Error "permission option was not offered by the agent"
          | selected ->
              let outcome =
                match selected with
                | Some option_id ->
                    `Assoc
                      [
                        ("outcome", `String "selected");
                        ("optionId", `String option_id);
                      ]
                | None -> `Assoc [ ("outcome", `String "cancelled") ]
              in
              ignore
                (Store.append_event state.store ~kind:"acp.permission.resolved"
                   (`Assoc
                      [
                        ("requestId", `String request_id);
                        ( "optionId",
                          Option.fold ~none:`Null
                            ~some:(fun value -> `String value)
                            selected );
                      ]));
              Hashtbl.remove state.pending_permissions request_id;
              state.send
                (Acp.response_with_id ~id:permission.Config.raw_id
                   (`Assoc [ ("outcome", outcome) ]));
              state.status :=
                if Hashtbl.length state.running_commands > 0 then Domain.Running
                else Domain.Idle;
              Ok (`Assoc [ ("resolved", `Bool true) ])))
