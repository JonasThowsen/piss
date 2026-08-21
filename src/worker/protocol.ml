(* Worker wire protocol: request handlers for the Unix-domain socket. *)

open Worker_prelude

let conflict reason = Result.Error (Error.Conflict { reason })
let validation field reason = Result.Error (Error.Validation { field; reason })
let upstream message = Result.Error (Error.Upstream_unavailable { message })
let internal message = Result.Error (Error.Internal { message })

let event_page events =
  events |> List.map Domain.event_to_yojson |> fun events -> Ok (`List events)

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

let dispatch_prompt state ?action ~target ~command_id ~text ~images ~resources
    () =
  let command_id = Domain.Command_id.to_string command_id in
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
      match
        Store.accept_targeted_command ?action store ~target ~content
          ~images:image_metadata ~resources:resources_metadata ~command_id
          ~request_id:command_id ~prompt:text
      with
      | Error reason -> conflict reason
      | Ok accepted when accepted.duplicate ->
          Ok
            (`Assoc
               ([
                  ("commandId", `String command_id);
                  ( "state",
                    `String (Domain.command_state_to_string accepted.state) );
                  ("duplicate", `Bool true);
                ]
               @
               match action with
               | Some value -> [ ("action", `String value) ]
               | None -> []))
      | Ok _ -> (
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
                    ("duplicate", `Bool false);
                  ]
                 @
                 match action with
                 | Some value -> [ ("action", `String value) ]
                 | None -> []))
          with exn ->
            State.record_dispatch_failed state ~command_id;
            internal (Printexc.to_string exn)))

let handle ~clock state request =
  let args = State.args state in
  let store = State.store state in
  let target =
    match request with
    | Wire.Cancel { target; _ }
    | Wire.Set_config_option { target; _ }
    | Wire.Permission { target; _ } ->
        Some target
    | _ -> None
  in
  match Option.map (Store.validate_runtime_target store) target with
  | Some (Error reason) -> conflict reason
  | None | Some (Ok ()) -> (
      match request with
      | Wire.Hello { protocol_version = (1 | 2) as protocol_version } ->
          Ok
            (`Assoc
               [
                 ("protocolVersion", `Int protocol_version);
                 ( "workerId",
                   `String
                     (Domain.Worker_id.to_string
                        (State.runtime_worker_id state)) );
                 ( "capabilities",
                   `List
                     ([
                        `String "events";
                        `String "wait_events";
                        `String "prompt";
                        `String "steer";
                        `String "follow_up";
                        `String "cancel";
                        `String "permission";
                        `String "config_options";
                      ]
                     @
                     if State.supports_images state then
                       [ `String "image_prompt" ]
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
                   :: ( "upgradePending",
                        `Bool (State.upgrade_is_preparing state) )
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
            State.runtime_busy state
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
          Store.list_events ~max_bytes:Config.max_event_page_bytes store ~after
            ~limit
          |> event_page
      | Wire.Wait_events { after; limit; timeout_ms } ->
          State.wait_events state ~clock ~after ~limit ~timeout_ms |> event_page
      | Wire.Events_before { before; limit } ->
          Store.list_events_before ~max_bytes:Config.max_event_page_bytes store
            ~before ~limit
          |> event_page
      | Wire.Recent_events { limit } ->
          Store.list_recent_events ~max_bytes:Config.max_event_page_bytes store
            ~limit
          |> event_page
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
            State.runtime_busy state
            || State.pending_permission_count state > 0
            || State.configuration_change_depth state > 0
            || State.status state <> Domain.Idle
          then
            conflict "the active session must be idle before creating another"
          else if State.additional_session_limit_reached state then
            (* TODO(tracer): Replace this in-adapter cap with one independently
               supervised worker per durable session before exposing unbounded
               session creation. pi-acp retains a Pi process for every
               session. *)
            conflict
              "restart the worker before creating more than four sessions"
          else (
            State.set_status state Domain.Starting;
            let created = State.create_harness_session state in
            State.record_additional_session state ~session_id:created;
            Ok (`Assoc [ ("sessionId", `String created) ]))
      | Wire.Prompt { images; _ }
        when images <> [] && not (State.supports_images state) ->
          validation "images" "the ACP agent does not accept image prompts"
      | Wire.Prompt { target; command_id; text; images; resources } -> (
          let command_id_text = Domain.Command_id.to_string command_id in
          (* A known command is a read of its durable receipt, not a new runtime
             mutation. Return it even after worker replacement so a
             response-loss retry can recover authoritatively with the original
             command identity. Unknown commands are fenced atomically with
             acceptance in [dispatch_prompt]. *)
          match Store.find_command store command_id_text with
          | Some command_state ->
              Ok
                (`Assoc
                   [
                     ("commandId", `String command_id_text);
                     ( "state",
                       `String (Domain.command_state_to_string command_state) );
                     ("duplicate", `Bool true);
                   ])
          | None when State.running_command_count state > 0 ->
              conflict "the session already has an active prompt"
          | None ->
              dispatch_prompt state ~target ~command_id ~text ~images ~resources
                ())
      | Wire.Deliver { images; _ }
        when images <> [] && not (State.supports_images state) ->
          validation "images" "the ACP agent does not accept image prompts"
      | Wire.Deliver { target; command_id; text; images; resources; action }
        -> (
          let command_id_text = Domain.Command_id.to_string command_id in
          match Store.find_command store command_id_text with
          | Some command_state ->
              Ok
                (`Assoc
                   [
                     ("commandId", `String command_id_text);
                     ( "state",
                       `String (Domain.command_state_to_string command_state) );
                     ("duplicate", `Bool true);
                   ])
          | None when not (State.runtime_busy state) ->
              conflict (action ^ " is only available during active agent work")
          | None ->
              dispatch_prompt state ~action ~target ~command_id ~text ~images
                ~resources ())
      | Wire.Recover_command
          { target; command_id; action; discard_cleared_attachments } -> (
          let command_id = Domain.Command_id.to_string command_id in
          if action = "prompt" && State.running_command_count state > 0 then
            conflict "the session already has an active prompt"
          else if action = "follow_up" && not (State.runtime_busy state) then
            conflict "follow_up recovery requires active agent work"
          else
            match
              Store.recover_targeted_text_command ~discard_cleared_attachments
                store ~target ~command_id ~action
            with
            | Error reason -> conflict reason
            | Ok recovered when recovered.duplicate ->
                Ok
                  (`Assoc
                     [
                       ("commandId", `String command_id);
                       ( "state",
                         `String
                           (Domain.command_state_to_string recovered.state) );
                       ("duplicate", `Bool true);
                       ("recovered", `Bool true);
                     ])
            | Ok recovered -> (
                try
                  let delivery =
                    if action = "follow_up" then Some action else None
                  in
                  State.record_dispatched state ~command_id;
                  State.send state
                    (Acp.prompt_request ~delivery ~command_id
                       ~session_id:(State.harness_session_id state)
                       ~text:recovered.prompt ~images:[] ~resources:[]);
                  Ok
                    (`Assoc
                       [
                         ("commandId", `String command_id);
                         ("state", `String "dispatched");
                         ("duplicate", `Bool false);
                         ("recovered", `Bool true);
                       ])
                with exn ->
                  State.record_dispatch_failed state ~command_id;
                  internal (Printexc.to_string exn)))
      (* TODO(tracer): Add a durable generic mutation-receipt ledger before
         making configuration, cancellation, or permission decisions
         automatically retryable after response loss. This prompt tracer binds
         and fences their stable mutation IDs but only command IDs currently
         have durable duplicate-result replay. *)
      | Wire.Set_config_option { target; mutation_id; config_id; value } -> (
          let mutation_id = Domain.Request_id.to_string mutation_id in
          match Store.validate_runtime_target store target with
          | Error reason -> conflict reason
          | Ok () ->
              if
                State.runtime_busy state
                || State.pending_permission_count state > 0
                || State.configuration_change_depth state > 0
                || State.status state <> Domain.Idle
              then conflict "session configuration can only change while idle"
              else
                let _, response =
                  State.change_config_option state ~id:mutation_id ~config_id
                    ~value
                in
                ignore
                  (State.append_event state ~kind:"acp.config_option.changed"
                     ~payload:
                       (`Assoc
                          [
                            ("mutationId", `String mutation_id);
                            ("response", response);
                          ]));
                Ok (`Assoc [ ("configOptions", State.config_options state) ]))
      | Wire.Cancel { target; mutation_id } -> (
          let mutation_id = Domain.Request_id.to_string mutation_id in
          match Store.validate_runtime_target store target with
          | Error reason -> conflict reason
          | Ok () ->
              if not (State.runtime_busy state) then
                conflict "the session has no active prompt"
              else (
                ignore
                  (State.append_event state ~kind:"command.cancel.requested"
                     ~payload:
                       (`Assoc
                          [
                            ( "sessionId",
                              `String (State.harness_session_id state) );
                            ("mutationId", `String mutation_id);
                          ]));
                State.send state
                  (Acp.cancel_notification
                     ~session_id:(State.harness_session_id state));
                Ok (`Assoc [ ("state", `String "cancelling") ])))
      | Wire.Peer_event { kind; request_id; peer_id; text } ->
          let request_id = Domain.Request_id.to_string request_id in
          State.append_event state ~kind
            ~payload:
              (`Assoc
                 [
                   ("requestId", `String request_id);
                   ("peerId", `String peer_id);
                   ("text", `String text);
                 ])
          |> Domain.event_to_yojson |> Result.ok
      | Wire.Permission { target; mutation_id; request_id; option_id } -> (
          let mutation_id = Domain.Request_id.to_string mutation_id in
          let request_id = Domain.Request_id.to_string request_id in
          match Store.validate_runtime_target store target with
          | Error reason -> conflict reason
          | Ok () -> (
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
                        (State.append_event state
                           ~kind:"acp.permission.resolved"
                           ~payload:
                             (`Assoc
                                [
                                  ("requestId", `String request_id);
                                  ("mutationId", `String mutation_id);
                                  ( "optionId",
                                    Option.fold ~none:`Null
                                      ~some:(fun value -> `String value)
                                      selected );
                                ]));
                      State.resolve_permission state ~request_id;
                      State.send state
                        (Acp.response_with_id ~id:permission.Config.raw_id
                           (`Assoc [ ("outcome", outcome) ]));
                      Ok (`Assoc [ ("resolved", `Bool true) ])))))
