(* Worker wire protocol: request handlers for the Unix-domain socket. *)

open Piss_core

let conflict reason = Result.Error (Error.Conflict { reason })
let validation field reason = Result.Error (Error.Validation { field; reason })
let upstream message = Result.Error (Error.Upstream_unavailable { message })
let internal message = Result.Error (Error.Internal { message })

let resolve_resources ~workspace resources =
  List.fold_left
    (fun resolved (resource : Domain.resource_input) ->
      Result.bind resolved (fun resources ->
          Workspace_io.resolve_resource ~root:workspace ~path:resource.path
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

let dispatch_prompt state ?action ~command_id ~text ~images ~resources () =
  let store = State.store state in
  match resolve_resources ~workspace:(State.workspace state) resources with
  | Error message -> validation "resources" message
  | Ok resolved_resources -> (
      let image_metadata = List.map Wire.image_metadata_to_yojson images in
      let resources_metadata = List.map resource_metadata resolved_resources in
      let content =
        `List
          (List.map Wire.image_to_yojson images
          @ List.map Wire.resource_to_yojson resources)
      in
      let accepted =
        Store.accept_command ?action store ~content ~images:image_metadata
          ~resources:resources_metadata ~command_id ~request_id:command_id
          ~prompt:text
      in
      try
        State.record_dispatched state ~command_id;
        State.send state
          (Acp.prompt_request ~delivery:action ~command_id
             ~session_id:(State.harness_session_id state)
             ~text ~images ~resources:resolved_resources);
        Store.clear_command_content store ~command_id;
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
        State.record_dispatch_failed state ~command_id;
        internal (Printexc.to_string exn))

let handle state request =
  let args = State.args state in
  let store = State.store state in
  match request with
  | Wire.Hello { protocol_version = 1 } ->
      Ok
        (`Assoc
           [
             ("protocolVersion", `Int 1);
             ("workerId", `String args.worker_id);
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
                 if State.supports_images state then [ `String "image_prompt" ]
                 else []) );
           ])
  | Wire.Hello { protocol_version } ->
      validation "protocolVersion"
        (Printf.sprintf "unsupported worker protocol version %d"
           protocol_version)
  | Wire.Snapshot -> (
      match Domain.snapshot_to_yojson (State.snapshot state) with
      | `Assoc fields ->
          Ok
            (`Assoc
               (("workerGeneration", `String args.generation)
               :: ("upgradePending", `Bool (State.upgrade_is_preparing state))
               :: ("acceptsImages", `Bool (State.supports_images state))
               :: ("configOptions", State.config_options state)
               :: fields))
      | _ -> assert false)
  | Wire.Prepare_upgrade { generation = target }
    when String.equal target args.generation ->
      Ok
        (`Assoc
           [
             ("ready", `Bool false);
             ("alreadyCurrent", `Bool true);
             ("generation", `String args.generation);
           ])
  | Wire.Prepare_upgrade { generation = target } ->
      if
        State.running_command_count state > 0
        || State.pending_permission_count state > 0
        || State.configuration_change_depth state > 0
        || State.status state <> Domain.Idle
      then conflict "worker is not idle and cannot prepare for upgrade"
      else
        let event =
          State.start_upgrade state ~target
            ~deadline:(Unix.gettimeofday () +. 30.)
        in
        Ok
          (`Assoc
             [
               ("ready", `Bool true);
               ("alreadyCurrent", `Bool false);
               ("generation", `String args.generation);
               ("targetGeneration", `String target);
               ("sequence", `Intlit (Int64.to_string event.sequence));
             ])
  | Wire.Events { after; limit } ->
      Store.list_events store ~after ~limit |> List.map Domain.event_to_yojson
      |> fun events -> Ok (`List events)
  | Wire.Events_before { before; limit } ->
      Store.list_events_before store ~before ~limit
      |> List.map Domain.event_to_yojson
      |> fun events -> Ok (`List events)
  | Wire.Recent_events { limit } ->
      Store.list_recent_events store ~limit |> List.map Domain.event_to_yojson
      |> fun events -> Ok (`List events)
  | Wire.File_search { query } ->
      Workspace_io.search ~root:(State.workspace state) ~query
      |> Result.map_error (fun message ->
          Error.Upstream_unavailable { message })
      |> Result.map (fun mentions ->
          `List (List.map Workspace_files.mention_to_yojson mentions))
  | Wire.Config_options -> Ok (State.config_options state)
  | _ when State.upgrade_is_preparing state ->
      upstream "worker is preparing for an immutable generation upgrade"
  | Wire.New_session ->
      if
        State.running_command_count state > 0
        || State.pending_permission_count state > 0
      then conflict "the active session must be idle before creating another"
      else if State.additional_session_limit_reached state then
        (* TODO(tracer): Replace this in-adapter cap with one independently
           supervised worker per durable session before exposing unbounded
           session creation. pi-acp retains a Pi process for every session. *)
        conflict "restart the worker before creating more than four sessions"
      else (
        State.set_status state Domain.Starting;
        let created = State.create_harness_session state in
        State.record_additional_session state ~session_id:created;
        Ok (`Assoc [ ("sessionId", `String created) ]))
  | Wire.Prompt { images; _ }
    when images <> [] && not (State.supports_images state) ->
      validation "images" "the ACP agent does not accept image prompts"
  | Wire.Prompt { command_id; text; images; resources } -> (
      match Store.find_command store command_id with
      | Some command_state ->
          Ok
            (`Assoc
               [
                 ("commandId", `String command_id);
                 ( "state",
                   `String (Domain.command_state_to_string command_state) );
                 ("duplicate", `Bool true);
               ])
      | None when State.running_command_count state > 0 ->
          conflict "the session already has an active prompt"
      | None -> dispatch_prompt state ~command_id ~text ~images ~resources ())
  | Wire.Deliver { images; _ }
    when images <> [] && not (State.supports_images state) ->
      validation "images" "the ACP agent does not accept image prompts"
  | Wire.Deliver { command_id; text; images; resources; action } -> (
      match Store.find_command store command_id with
      | Some command_state ->
          Ok
            (`Assoc
               [
                 ("commandId", `String command_id);
                 ( "state",
                   `String (Domain.command_state_to_string command_state) );
                 ("duplicate", `Bool true);
               ])
      | None when State.running_command_count state = 0 ->
          conflict (action ^ " is only available during an active prompt")
      | None ->
          dispatch_prompt state ~action ~command_id ~text ~images ~resources ())
  | Wire.Set_config_option { config_id; value } ->
      if
        State.running_command_count state > 0
        || State.pending_permission_count state > 0
      then conflict "session configuration can only change while idle"
      else
        let id =
          "config-"
          ^ Digest.to_hex
              (Digest.string
                 (config_id ^ "\000" ^ value ^ "\000"
                 ^ string_of_float (Unix.gettimeofday ())))
        in
        let _, response =
          State.change_config_option state ~id ~config_id ~value
        in
        ignore
          (Store.append_event store ~kind:"acp.config_option.changed"
             ~payload:response);
        Ok (`Assoc [ ("configOptions", State.config_options state) ])
  | Wire.Cancel ->
      if State.running_command_count state = 0 then
        conflict "the session has no active prompt"
      else (
        ignore
          (Store.append_event store ~kind:"command.cancel.requested"
             ~payload:
               (`Assoc
                  [ ("sessionId", `String (State.harness_session_id state)) ]));
        State.send state
          (Acp.cancel_notification ~session_id:(State.harness_session_id state));
        Ok (`Assoc [ ("state", `String "cancelling") ]))
  | Wire.Peer_event { kind; request_id; peer_id; text } ->
      Store.append_event store ~kind
        ~payload:
          (`Assoc
             [
               ("requestId", `String request_id);
               ("peerId", `String peer_id);
               ("text", `String text);
             ])
      |> Domain.event_to_yojson |> Result.ok
  | Wire.Permission { request_id; option_id } -> (
      match State.pending_permission state ~request_id with
      | None ->
          Result.Error
            (Error.Not_found
               { resource = "permission request"; id = request_id })
      | Some permission -> (
          match option_id with
          | Some selected
            when not
                   (Harness.option_is_offered ~params:permission.params
                      ~option_id:selected) ->
              conflict "permission option was not offered by the agent"
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
                (Store.append_event store ~kind:"acp.permission.resolved"
                   ~payload:
                     (`Assoc
                        [
                          ("requestId", `String request_id);
                          ( "optionId",
                            Option.fold ~none:`Null
                              ~some:(fun value -> `String value)
                              selected );
                        ]));
              State.resolve_permission state ~request_id;
              State.send state
                (Acp.response_with_id ~id:permission.Config.raw_id
                   (`Assoc [ ("outcome", outcome) ]));
              Ok (`Assoc [ ("resolved", `Bool true) ])))
