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
  let reconciled_commands = Store.reconcile_incomplete_commands store in
  if reconciled_commands <> [] then
    Format.eprintf "reconciled %d incomplete command(s) as ambiguous@."
      (List.length reconciled_commands);
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
  let running_commands : (string, float) Hashtbl.t = Hashtbl.create 4 in
  let pending_permissions : (string, Config.pending_permission) Hashtbl.t =
    Hashtbl.create 8
  in
  let configuration_changes = ref 0 in
  let status = ref Domain.Starting in
  let upgrade_target = ref None in
  let upgrade_deadline = ref 0. in
  let harness_session_id = ref "" in
  let config_options = ref (`List []) in
  let sessions_created_since_start = ref 0 in
  let selected_config_values () =
    match !config_options with
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
  in
  let persist_config_values () =
    Store.set_metadata store "config_option_values"
      (Yojson.Safe.to_string (selected_config_values ()))
  in
  let expire_stuck_commands () =
    let now = Unix.gettimeofday () in
    let stuck =
      Hashtbl.fold
        (fun command_id dispatched_at acc ->
          if now -. dispatched_at > Config.dispatch_timeout_seconds then
            (command_id, dispatched_at) :: acc
          else acc)
        running_commands []
    in
    List.iter
      (fun (command_id, _) ->
        let claimed =
          Store.try_set_command_state_if_open store ~command_id Domain.Ambiguous
        in
        Hashtbl.remove running_commands command_id;
        if claimed then (
          status :=
            if Hashtbl.length pending_permissions > 0 then
              Domain.Requires_action
            else if Hashtbl.length running_commands > 0 then Domain.Running
            else Domain.Idle;
          ignore
            (Store.append_event store ~kind:"command.dispatch_timeout"
               ~payload:
                 (`Assoc
                    [
                      ("commandId", `String command_id);
                      ("timeoutSeconds", `Float Config.dispatch_timeout_seconds);
                      ( "reason",
                        `String
                          "harness did not acknowledge the dispatched command \
                           within the configured budget" );
                    ]))))
      stuck
  in
  let expire_stuck_permissions () =
    let now = Unix.gettimeofday () in
    let stuck =
      Hashtbl.fold
        (fun request_id permission acc ->
          if
            now -. permission.Config.requested_at
            > Config.permission_timeout_seconds
          then (request_id, permission) :: acc
          else acc)
        pending_permissions []
    in
    List.iter
      (fun (request_id, permission) ->
        Hashtbl.remove pending_permissions request_id;
        ignore
          (Store.append_event store ~kind:"acp.permission.expired"
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
        send
          (Acp.response_with_id ~id:permission.Config.raw_id
             (`Assoc
                [ ("outcome", `Assoc [ ("outcome", `String "cancelled") ]) ])))
      stuck;
    if stuck <> [] then
      status :=
        if Hashtbl.length running_commands > 0 then Domain.Running
        else Domain.Idle
  in
  let fail_pending message =
    Hashtbl.iter
      (fun _ resolver ->
        ignore (Eio.Promise.try_resolve resolver (Error message)))
      pending_responses;
    Hashtbl.clear pending_responses
  in
  Eio.Fiber.fork ~sw (fun () ->
      while true do
        Eio.Time.sleep clock 5.0;
        expire_stuck_commands ();
        expire_stuck_permissions ()
      done);
  Eio.Fiber.fork ~sw (fun () ->
      try
        while true do
          let json = read_json harness_reader in
          let durable_json = Acp.redact_user_image_data json in
          ignore
            (Store.append_event store ~kind:(Harness.event_kind json)
               ~payload:durable_json);
          match Acp.envelope_of_yojson json with
          | Ok (Acp.Response { id; error; _ }) -> (
              match Hashtbl.find_opt pending_responses id with
              | Some resolver ->
                  Hashtbl.remove pending_responses id;
                  ignore (Eio.Promise.try_resolve resolver (Ok json))
              | None when Hashtbl.mem running_commands id ->
                  Hashtbl.remove running_commands id;
                  let state =
                    match (error, Harness.response_stop_reason json) with
                    | Some _, _ -> Domain.Rejected
                    | None, Some "cancelled" -> Domain.Cancelled
                    | None, _ -> Domain.Completed
                  in
                  Store.set_command_state store ~command_id:id state;
                  status :=
                    if Hashtbl.length pending_permissions > 0 then
                      Domain.Requires_action
                    else if Hashtbl.length running_commands > 0 then
                      Domain.Running
                    else Domain.Idle
              | None -> ())
          | Ok
              (Acp.Request
                 { id; method_ = "session/request_permission"; params }) ->
              let raw_id = Yojson.Safe.Util.member "id" json in
              Hashtbl.replace pending_permissions id
                { Config.raw_id; params; requested_at = Unix.gettimeofday () };
              status := Domain.Requires_action
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
              let update = Yojson.Safe.Util.member "update" params in
              match Yojson.Safe.Util.member "configOptions" update with
              | `List _ as options -> config_options := options
              | _ -> ())
          | Ok (Acp.Notification { method_ = "$/cancel_request"; params }) -> (
              match Yojson.Safe.Util.member "id" params |> Acp.id_to_string with
              | Some id when Hashtbl.mem pending_permissions id ->
                  Hashtbl.remove pending_permissions id;
                  ignore
                    (Store.append_event store ~kind:"acp.permission.cancelled"
                       ~payload:(`Assoc [ ("requestId", `String id) ]));
                  status :=
                    if Hashtbl.length running_commands > 0 then Domain.Running
                    else Domain.Idle
              | _ -> ())
          | Ok _ -> ()
          | Error message -> raise (Failure message)
        done
      with
      | End_of_file ->
          status := Domain.Failed;
          fail_pending "ACP harness disconnected";
          ignore
            (Store.append_event store ~kind:"harness.disconnected"
               ~payload:(`Assoc [ ("harnessPid", `Int harness_pid) ]));
          raise End_of_file
      | exn ->
          status := Domain.Failed;
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
  let create_session () =
    let result, response =
      require_rpc_result ~id:"session-new"
        (Acp.new_session_request ~cwd:workspace ~session_id:args.session_id
           ~mcp_command:args.session_mcp ~broker_url:args.broker_url
           ~broker_token:args.broker_token ~curl_command:args.curl_command)
    in
    let created =
      match Yojson.Safe.Util.member "sessionId" result with
      | `String value -> value
      | _ -> raise (Failure "ACP agent did not return a sessionId")
    in
    Store.set_metadata store "acp_session_id" created;
    (match Yojson.Safe.Util.member "configOptions" result with
    | `List _ as options -> config_options := options
    | _ -> ());
    ignore
      (Store.append_event store ~kind:"acp.session.created" ~payload:response);
    created
  in
  let session_id_from_agent =
    match (Store.get_metadata store "acp_session_id", supports_load) with
    | Some existing, true -> (
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
                | `List _ as options -> config_options := options
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
                create_session ())
        | Error message ->
            ignore
              (Store.append_event store ~kind:"acp.session.load_failed"
                 ~payload:
                   (`Assoc
                      [
                        ("sessionId", `String existing);
                        ("error", `String message);
                      ]));
            create_session ())
    | _ -> create_session ()
  in
  harness_session_id := session_id_from_agent;
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
      let current_value =
        match !config_options with
        | `List options ->
            List.find_map
              (fun option ->
                match
                  ( Yojson.Safe.Util.member "id" option,
                    Yojson.Safe.Util.member "currentValue" option )
                with
                | `String id, `String current when id = config_id ->
                    Some current
                | _ -> None)
              options
        | _ -> None
      in
      match current_value with
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
            let result, response =
              require_rpc_result ~id
                (Acp.set_config_option_request ~id
                   ~session_id:!harness_session_id ~config_id ~value)
            in
            (match Yojson.Safe.Util.member "configOptions" result with
            | `List _ as options -> config_options := options
            | _ -> ());
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
  status := Domain.Idle;
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
  let protocol_state : Protocol.t =
    {
      args;
      store;
      workspace;
      agent_name;
      supports_load;
      supports_images;
      harness_pid;
      harness_session_id;
      config_options;
      status;
      running_commands;
      pending_permissions;
      configuration_changes;
      upgrade_target;
      upgrade_deadline;
      sessions_created_since_start;
      send;
      persist_config_values;
      create_session;
      require_rpc_result;
    }
  in
  let handle_connection flow _address =
    let reader = Eio.Buf_read.of_flow flow ~max_size:Config.max_frame_bytes in
    let receive () =
      try
        let json = read_json reader in
        match Wire.request_of_yojson json with
        | Ok request -> Ok request
        | Error message -> Error message
      with
      | Yojson.Json_error message -> Error ("invalid JSON: " ^ message)
      | Eio.Buf_read.Buffer_limit_exceeded -> Error "worker frame is too large"
      | exn -> Error (Printexc.to_string exn)
    in
    match receive () with
    | Ok (Wire.Hello _ as hello) -> (
        let negotiation = Protocol.handle protocol_state hello in
        write_json flow (Wire.response_to_yojson negotiation);
        match negotiation with
        | Error _ -> ()
        | Ok _ -> (
            match receive () with
            | Ok request ->
                write_json flow
                  (Wire.response_to_yojson
                     (Protocol.handle protocol_state request))
            | Error message ->
                write_json flow (Wire.response_to_yojson (Error message))))
    | Ok _ ->
        write_json flow
          (Wire.response_to_yojson
             (Error "hello must be the first request on a worker connection"))
    | Error message -> write_json flow (Wire.response_to_yojson (Error message))
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
    args.session_id args.worker_id (Unix.getpid ()) harness_pid args.socket_path;
  Eio.Net.run_server socket handle_connection
    ~on_error:(fun exn ->
      Format.eprintf "worker connection failed: %a@." Eio.Exn.pp exn)
    ~max_connections:32

let () =
  let args = Config.parse () in
  Eio_main.run @@ fun env -> run ~env args
