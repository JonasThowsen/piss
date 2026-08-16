(* Entry point and orchestration for the piss-session-worker binary. *)

open Piss_core

let write_json sink json =
  Eio.Flow.copy_string (Yojson.Safe.to_string json ^ "\n") sink

let read_json reader = Eio.Buf_read.line reader |> Yojson.Safe.from_string

let run ~env (args : Config.args) =
  let workspace = Unix.realpath args.workspace in
  if (Unix.stat workspace).st_kind <> Unix.S_DIR then
    failwith "authorized workspace is not a directory";
  let store =
    Store.open_ ~path:args.database_path
      ~session_id:(Domain.session_id args.session_id)
      ~worker_id:(Domain.worker_id args.worker_id)
  in
  let runtime_identity = Store.claim_runtime store in
  let reconciled_commands = Store.reconcile_incomplete_commands store in
  if reconciled_commands <> [] then
    Format.eprintf "reconciled %d incomplete command(s) as ambiguous@."
      (List.length reconciled_commands);
  let terminal_commands = Store.reconcile_ambiguous_responses store in
  if terminal_commands <> [] then
    Format.eprintf "reconciled %d ambiguous command(s) from ACP responses@."
      (List.length terminal_commands);
  Fun.protect ~finally:(fun () -> Store.close store) @@ fun () ->
  Eio.Switch.run @@ fun sw ->
  let clock = Eio.Stdenv.clock env in
  let process_mgr = Eio.Stdenv.process_mgr env in
  let stderr = Eio.Stdenv.stderr env in
  let harness =
    Harness.spawn ~sw ~process_mgr ~stderr ~command:args.harness_command
      ~args:args.harness_args
  in
  let harness_pid = harness.Harness.pid in
  let harness_reader = harness.Harness.stdout in
  let outgoing = Eio.Stream.create 64 in
  let send json = Eio.Stream.add outgoing json in
  Eio.Fiber.fork ~sw (fun () ->
      while true do
        Eio.Stream.take outgoing |> write_json harness.Harness.stdin
      done);
  let pending_responses = Hashtbl.create 16 in
  let session_load_in_progress = ref false in
  let fail_pending message =
    Hashtbl.iter
      (fun _ resolver ->
        ignore (Eio.Promise.try_resolve resolver (Error message)))
      pending_responses;
    Hashtbl.clear pending_responses
  in
  let rpc_request ~id json =
    if Hashtbl.mem pending_responses id then
      Error ("duplicate in-flight ACP request: " ^ id)
    else
      let promise, resolver = Eio.Promise.create () in
      Hashtbl.add pending_responses id resolver;
      send json;
      Eio.Promise.await promise
  in
  let require_rpc_result ~id json =
    match rpc_request ~id json with
    | Error message -> raise (Failure message)
    | Ok response -> (
        match Acp.response_result ~expected_id:id response with
        | Ok result -> (result, response)
        | Error message -> raise (Failure message))
  in
  let state =
    State.make ~args ~store ~workspace ~harness_pid
      ~runtime_worker_id:runtime_identity.worker_id
      ~runtime_generation:runtime_identity.runtime_generation ~send
      ~require_rpc_result
  in
  Eio.Fiber.fork ~sw (fun () ->
      while true do
        Eio.Time.sleep clock 5.0;
        let now = Unix.gettimeofday () in
        State.expire_stuck_permissions state ~now
      done);
  Eio.Fiber.fork ~sw (fun () ->
      try
        while true do
          let json = read_json harness_reader in
          let envelope = Acp.envelope_of_yojson json in
          (* session/load emits the saved transcript before its response. The
             ledger already owns that history, so process the replay for live
             state reconstruction without storing it as new activity. *)
          let replayed_session_update =
            !session_load_in_progress
            &&
            match envelope with
            | Ok (Acp.Notification { method_ = "session/update"; _ }) -> true
            | Ok _ | Error _ -> false
          in
          (if not replayed_session_update then
             let durable_json = Acp.redact_user_image_data json in
             ignore
               (Store.append_event store ~kind:(Harness.event_kind json)
                  ~payload:durable_json));
          (match envelope with
          | Ok (Acp.Response { id = "session-load"; _ }) ->
              session_load_in_progress := false
          | Ok _ | Error _ -> ());
          match envelope with
          | Ok (Acp.Response { id; error; _ }) -> (
              match Hashtbl.find_opt pending_responses id with
              | Some resolver ->
                  Hashtbl.remove pending_responses id;
                  ignore (Eio.Promise.try_resolve resolver (Ok json))
              | None
                when State.is_running_command state ~command_id:id
                     || Store.find_command store id = Some Domain.Ambiguous ->
                  let command_state =
                    match (error, Harness.response_stop_reason json) with
                    | Some _, _ -> Domain.Rejected
                    | None, Some "cancelled" -> Domain.Cancelled
                    | None, _ -> Domain.Completed
                  in
                  State.record_completed state ~command_id:id
                    ~state:command_state
              | None -> ())
          | Ok
              (Acp.Request
                 { id; method_ = "session/request_permission"; params }) ->
              State.record_pending_permission state ~request_id:id
                ~raw_id:(Yojson.Safe.Util.member "id" json)
                ~params
          | Ok (Acp.Request { id; method_; _ }) ->
              send
                (Acp.error_response_with_id
                   ~id:(Yojson.Safe.Util.member "id" json)
                   ~code:(-32601)
                   ~message:("unsupported ACP client method: " ^ method_));
              ignore
                (Store.append_event store ~kind:"acp.client_request.rejected"
                   ~payload:
                     (`Assoc
                        [
                          ("requestId", `String id); ("method", `String method_);
                        ]))
          | Ok (Acp.Notification { method_ = "session/update"; params }) -> (
              match Yojson.Safe.Util.member "sessionId" params with
              | `String session_id
                when String.equal session_id (State.harness_session_id state)
                -> (
                  let update = Yojson.Safe.Util.member "update" params in
                  (match Yojson.Safe.Util.member "configOptions" update with
                  | `List _ as options -> State.set_config_options state options
                  | _ -> ());
                  let harness_running =
                    match Yojson.Safe.Util.member "_meta" update with
                    | `Assoc _ as metadata -> (
                        match Yojson.Safe.Util.member "piAcp" metadata with
                        | `Assoc _ as pi_acp ->
                            Yojson.Safe.Util.member "running" pi_acp
                        | _ -> `Null)
                    | _ -> `Null
                  in
                  match harness_running with
                  | `Bool running -> State.set_harness_running state running
                  | _ -> ())
              | _ -> ())
          | Ok (Acp.Notification { method_ = "$/cancel_request"; params }) -> (
              match Yojson.Safe.Util.member "id" params |> Acp.id_to_string with
              | Some id when State.cancel_permission state ~request_id:id ->
                  ignore
                    (Store.append_event store ~kind:"acp.permission.cancelled"
                       ~payload:(`Assoc [ ("requestId", `String id) ]))
              | _ -> ())
          | Ok _ -> ()
          | Error message -> raise (Failure message)
        done
      with
      | End_of_file ->
          State.set_status state Domain.Failed;
          fail_pending "ACP harness disconnected";
          ignore
            (Store.append_event store ~kind:"harness.disconnected"
               ~payload:(`Assoc [ ("harnessPid", `Int harness_pid) ]));
          raise End_of_file
      | exn ->
          State.set_status state Domain.Failed;
          fail_pending (Printexc.to_string exn);
          ignore
            (Store.append_event store ~kind:"harness.protocol_error"
               ~payload:
                 (`Assoc
                    [
                      ("harnessPid", `Int harness_pid);
                      ("error", `String (Printexc.to_string exn));
                    ]));
          raise exn);
  let initialize_result, initialize_response =
    require_rpc_result ~id:"initialize" Acp.initialize_request
  in
  ignore
    (Store.append_event store ~kind:"acp.initialize"
       ~payload:initialize_response);
  (match Yojson.Safe.Util.member "protocolVersion" initialize_result with
  | `Int 1 -> ()
  | _ -> raise (Failure "ACP agent did not negotiate protocol version 1"));
  let agent_name =
    let agent_info = Yojson.Safe.Util.member "agentInfo" initialize_result in
    match Yojson.Safe.Util.member "title" agent_info with
    | `String value -> value
    | _ -> (
        match Yojson.Safe.Util.member "name" agent_info with
        | `String value -> value
        | _ -> "ACP agent")
  in
  let supports_load =
    match
      Yojson.Safe.Util.(
        initialize_result |> member "agentCapabilities" |> member "loadSession")
    with
    | `Bool value -> value
    | _ -> false
  in
  let supports_images =
    match
      Yojson.Safe.Util.(
        initialize_result |> member "agentCapabilities"
        |> member "promptCapabilities"
        |> member "image")
    with
    | `Bool value -> value
    | _ -> false
  in
  State.initialize_agent state ~name:agent_name ~supports_load ~supports_images;
  let session_id_from_agent =
    match (Store.get_metadata store "acp_session_id", supports_load) with
    | Some existing, true -> (
        session_load_in_progress := true;
        match
          rpc_request ~id:"session-load"
            (Acp.load_session_request ~session_id:existing ~cwd:workspace
               ~piss_session_id:args.session_id ~mcp_command:args.session_mcp
               ~broker_url:args.broker_url ~broker_token:args.broker_token
               ~curl_command:args.curl_command)
        with
        | Ok response -> (
            match Acp.response_result ~expected_id:"session-load" response with
            | Ok result ->
                (match Yojson.Safe.Util.member "configOptions" result with
                | `List _ as options -> State.set_config_options state options
                | _ -> ());
                ignore
                  (Store.append_event store ~kind:"acp.session.loaded"
                     ~payload:response);
                existing
            | Error message ->
                ignore
                  (Store.append_event store ~kind:"acp.session.load_failed"
                     ~payload:
                       (`Assoc
                          [
                            ("sessionId", `String existing);
                            ("error", `String message);
                          ]));
                State.create_harness_session state)
        | Error message ->
            session_load_in_progress := false;
            ignore
              (Store.append_event store ~kind:"acp.session.load_failed"
                 ~payload:
                   (`Assoc
                      [
                        ("sessionId", `String existing);
                        ("error", `String message);
                      ]));
            State.create_harness_session state)
    | _ -> State.create_harness_session state
  in
  State.set_harness_session_id state session_id_from_agent;
  let persisted_config_values =
    match Store.get_metadata store "config_option_values" with
    | None -> []
    | Some encoded -> (
        try
          match Yojson.Safe.from_string encoded with
          | `Assoc values ->
              List.filter_map
                (function id, `String value -> Some (id, value) | _ -> None)
                values
          | _ -> []
        with Yojson.Json_error _ -> [])
  in
  let config_restore_priority (id, _) = if id = "model" then 0 else 1 in
  persisted_config_values
  |> List.stable_sort (fun left right ->
      Int.compare (config_restore_priority left) (config_restore_priority right))
  |> List.iter (fun (config_id, value) ->
      match State.current_config_value state ~config_id with
      | None -> ()
      | Some current when current = value -> ()
      | Some _ -> (
          let id =
            "config-restore-"
            ^ Digest.to_hex
                (Digest.string
                   (config_id ^ "\000" ^ value ^ "\000" ^ args.generation))
          in
          try
            let _, response =
              State.change_config_option state ~id ~config_id ~value
            in
            ignore
              (Store.append_event store ~kind:"acp.config_option.restored"
                 ~payload:
                   (`Assoc
                      [
                        ("configId", `String config_id);
                        ("value", `String value);
                        ("response", response);
                      ]))
          with exn ->
            ignore
              (Store.append_event store ~kind:"acp.config_option.restore_failed"
                 ~payload:
                   (`Assoc
                      [
                        ("configId", `String config_id);
                        ("value", `String value);
                        ("error", `String (Printexc.to_string exn));
                      ]))));
  State.refresh_status state;
  let previous_generation = Store.get_metadata store "worker_generation" in
  Store.set_metadata store "worker_generation" args.generation;
  (match Store.get_metadata store "pending_worker_upgrade" with
  | Some target when String.equal target args.generation ->
      ignore
        (Store.append_event store ~kind:"worker.upgrade.completed"
           ~payload:
             (`Assoc
                [
                  ( "fromGeneration",
                    Option.fold ~none:`Null
                      ~some:(fun value -> `String value)
                      previous_generation );
                  ("toGeneration", `String args.generation);
                  ("workerPid", `Int (Unix.getpid ()));
                ]));
      Store.set_metadata store "pending_worker_upgrade" ""
  | _ -> ());
  let handle_connection flow _address =
    let reader = Eio.Buf_read.of_flow flow ~max_size:Config.max_frame_bytes in
    let receive decode =
      try
        let json = read_json reader in
        decode json
        |> Result.map_error (fun reason ->
            Error.Validation { field = "request"; reason })
      with
      | Yojson.Json_error message ->
          Error
            (Error.Validation
               { field = "request"; reason = "invalid JSON: " ^ message })
      | Eio.Buf_read.Buffer_limit_exceeded ->
          Error
            (Error.Validation
               { field = "request"; reason = "worker frame is too large" })
      | exn -> Error (Error.Internal { message = Printexc.to_string exn })
    in
    match receive Wire.request_of_yojson with
    | Ok (Wire.Hello { protocol_version } as hello) -> (
        let negotiation = Protocol.handle state hello in
        write_json flow (Wire.response_to_yojson negotiation);
        match negotiation with
        | Error _ -> ()
        | Ok _ -> (
            let decode =
              if protocol_version = 1 then fun json ->
                let mutation_id =
                  "legacy-"
                  ^ Digest.to_hex
                      (Digest.string
                         (Yojson.Safe.to_string json ^ "\000"
                         ^ string_of_float (Unix.gettimeofday ())))
                in
                Wire.request_of_yojson_v1
                  ~target:(State.runtime_target state)
                  ~mutation_id json
              else Wire.request_of_yojson
            in
            match receive decode with
            | Ok request ->
                Protocol.handle state request
                |> Wire.response_to_yojson |> write_json flow
            | Error error ->
                write_json flow (Wire.response_to_yojson (Error error))))
    | Ok _ ->
        write_json flow
          (Wire.response_to_yojson
             (Error
                (Error.Validation
                   {
                     field = "op";
                     reason =
                       "hello must be the first request on a worker connection";
                   })))
    | Error error -> write_json flow (Wire.response_to_yojson (Error error))
  in
  let net = Eio.Stdenv.net env in
  (try Unix.unlink args.socket_path
   with Unix.Unix_error (Unix.ENOENT, _, _) -> ());
  let socket =
    Eio.Net.listen net ~sw ~backlog:32 ~reuse_addr:true (`Unix args.socket_path)
  in
  Unix.chmod args.socket_path 0o600;
  Printf.printf
    "worker_ready session=%s worker=%s pid=%d harness_pid=%d socket=%s\n%!"
    args.session_id runtime_identity.worker_id (Unix.getpid ()) harness_pid
    args.socket_path;
  Eio.Net.run_server socket handle_connection
    ~on_error:(fun exn ->
      Format.eprintf "worker connection failed: %a@." Eio.Exn.pp exn)
    ~max_connections:32

let () =
  let args = Config.parse () in
  Eio_main.run @@ fun env -> run ~env args
