open Piss_core

let max_frame_bytes = 1024 * 1024

type pending_permission = { raw_id : Yojson.Safe.t; params : Yojson.Safe.t }

let write_json sink json =
  Eio.Flow.copy_string (Yojson.Safe.to_string json ^ "\n") sink

let read_json reader = Eio.Buf_read.line reader |> Yojson.Safe.from_string

let event_kind json =
  let open Yojson.Safe.Util in
  match member "method" json with
  | `String "session/update" -> (
      match
        json |> member "params" |> member "update" |> member "sessionUpdate"
      with
      | `String kind -> "acp." ^ kind
      | _ -> "acp.session_update")
  | `String "session/request_permission" -> "acp.permission.requested"
  | `String method_ -> "acp.request." ^ method_
  | _ -> "acp.response"

let option_is_offered params option_id =
  match Yojson.Safe.Util.member "options" params with
  | `List options ->
      List.exists
        (fun option ->
          match Yojson.Safe.Util.member "optionId" option with
          | `String value -> String.equal value option_id
          | _ -> false)
        options
  | _ -> false

let response_stop_reason json =
  match Yojson.Safe.Util.(json |> member "result" |> member "stopReason") with
  | `String value -> Some value
  | _ -> None

let run ~env ~socket_path ~database_path ~session_id ~worker_id ~workspace
    ~harness_command ~harness_args ~session_mcp ~broker_url ~broker_token
    ~curl_command =
  let store =
    Store.open_ ~path:database_path ~session_id:(Domain.Session_id session_id)
      ~worker_id:(Domain.Worker_id worker_id)
  in
  let reconciled_commands = Store.reconcile_incomplete_commands store in
  if reconciled_commands <> [] then
    Format.eprintf "reconciled %d incomplete command(s) as ambiguous@."
      (List.length reconciled_commands);
  Fun.protect ~finally:(fun () -> Store.close store) @@ fun () ->
  Eio.Switch.run @@ fun sw ->
  let process_mgr = Eio.Stdenv.process_mgr env in
  let harness_stdout, harness_stdout_sink = Eio.Process.pipe ~sw process_mgr in
  let harness_stdin_source, harness_stdin = Eio.Process.pipe ~sw process_mgr in
  let harness =
    Eio.Process.spawn ~sw process_mgr ~stdin:harness_stdin_source
      ~stdout:harness_stdout_sink ~stderr:(Eio.Stdenv.stderr env)
      (harness_command :: harness_args)
  in
  Eio.Flow.close harness_stdout_sink;
  Eio.Flow.close harness_stdin_source;
  let harness_pid = Eio.Process.pid harness in
  let harness_reader =
    Eio.Buf_read.of_flow harness_stdout ~max_size:max_frame_bytes
  in
  let outgoing = Eio.Stream.create 64 in
  let pending_responses = Hashtbl.create 16 in
  let running_commands : (string, unit) Hashtbl.t = Hashtbl.create 4 in
  let pending_permissions : (string, pending_permission) Hashtbl.t =
    Hashtbl.create 8
  in
  let status = ref Domain.Starting in
  let harness_session_id = ref "" in
  let config_options = ref (`List []) in
  let send json = Eio.Stream.add outgoing json in
  let fail_pending message =
    Hashtbl.iter
      (fun _ resolver ->
        ignore (Eio.Promise.try_resolve resolver (Error message)))
      pending_responses;
    Hashtbl.clear pending_responses
  in
  Eio.Fiber.fork ~sw (fun () ->
      while true do
        Eio.Stream.take outgoing |> write_json harness_stdin
      done);
  Eio.Fiber.fork ~sw (fun () ->
      try
        while true do
          let json = read_json harness_reader in
          ignore (Store.append_event store ~kind:(event_kind json) json);
          match Acp.envelope_of_yojson json with
          | Ok (Acp.Response { id; error; _ }) -> (
              match Hashtbl.find_opt pending_responses id with
              | Some resolver ->
                  Hashtbl.remove pending_responses id;
                  ignore (Eio.Promise.try_resolve resolver (Ok json))
              | None when Hashtbl.mem running_commands id ->
                  Hashtbl.remove running_commands id;
                  let state =
                    match (error, response_stop_reason json) with
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
              Hashtbl.replace pending_permissions id { raw_id; params };
              status := Domain.Requires_action
          | Ok (Acp.Request { id; method_; _ }) ->
              send
                (Acp.error_response_with_id
                   ~id:(Yojson.Safe.Util.member "id" json)
                   ~code:(-32601)
                   ~message:("unsupported ACP client method: " ^ method_));
              ignore
                (Store.append_event store ~kind:"acp.client_request.rejected"
                   (`Assoc
                      [ ("requestId", `String id); ("method", `String method_) ]))
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
                       (`Assoc [ ("requestId", `String id) ]));
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
               (`Assoc [ ("harnessPid", `Int harness_pid) ]));
          raise End_of_file
      | exn ->
          status := Domain.Failed;
          fail_pending (Printexc.to_string exn);
          ignore
            (Store.append_event store ~kind:"harness.protocol_error"
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
  ignore (Store.append_event store ~kind:"acp.initialize" initialize_response);
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
  let create_session () =
    let result, response =
      require_rpc_result ~id:"session-new"
        (Acp.new_session_request ~cwd:workspace ~session_id
           ~mcp_command:session_mcp ~broker_url ~broker_token ~curl_command)
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
    ignore (Store.append_event store ~kind:"acp.session.created" response);
    created
  in
  let session_id_from_agent =
    match (Store.get_metadata store "acp_session_id", supports_load) with
    | Some existing, true -> (
        match
          rpc_request ~id:"session-load"
            (Acp.load_session_request ~session_id:existing ~cwd:workspace
               ~piss_session_id:session_id ~mcp_command:session_mcp ~broker_url
               ~broker_token ~curl_command)
        with
        | Ok response -> (
            match Acp.response_result ~expected_id:"session-load" response with
            | Ok result ->
                (match Yojson.Safe.Util.member "configOptions" result with
                | `List _ as options -> config_options := options
                | _ -> ());
                ignore
                  (Store.append_event store ~kind:"acp.session.loaded" response);
                existing
            | Error message ->
                ignore
                  (Store.append_event store ~kind:"acp.session.load_failed"
                     (`Assoc
                        [
                          ("sessionId", `String existing);
                          ("error", `String message);
                        ]));
                create_session ())
        | Error message ->
            ignore
              (Store.append_event store ~kind:"acp.session.load_failed"
                 (`Assoc
                    [
                      ("sessionId", `String existing); ("error", `String message);
                    ]));
            create_session ())
    | _ -> create_session ()
  in
  harness_session_id := session_id_from_agent;
  status := Domain.Idle;
  let sessions_created_since_start = ref 0 in
  let worker_snapshot () =
    Domain.
      {
        session_id = Session_id session_id;
        worker_id = Worker_id worker_id;
        runtime_generation = Runtime_generation 1;
        worker_pid = Unix.getpid ();
        harness_pid = Some harness_pid;
        agent_name;
        status = !status;
        last_sequence = Store.last_sequence store;
      }
  in
  let handle_request request =
    match request with
    | Wire.Hello { protocol_version = 1 } ->
        Ok
          (`Assoc
             [
               ("protocolVersion", `Int 1);
               ("workerId", `String worker_id);
               ( "capabilities",
                 `List
                   [
                     `String "events";
                     `String "prompt";
                     `String "steer";
                     `String "follow_up";
                     `String "cancel";
                     `String "permission";
                     `String "config_options";
                   ] );
             ])
    | Wire.Hello { protocol_version } ->
        Error
          (Printf.sprintf "unsupported worker protocol version %d"
             protocol_version)
    | Wire.Snapshot -> (
        let snapshot = Domain.snapshot_to_yojson (worker_snapshot ()) in
        match snapshot with
        | `Assoc fields ->
            Ok (`Assoc (("configOptions", !config_options) :: fields))
        | _ -> assert false)
    | Wire.Events { after; limit } ->
        let events = Store.list_events store ~after ~limit in
        Ok (`List (List.map Domain.event_to_yojson events))
    | Wire.Recent_events { limit } ->
        let events = Store.list_recent_events store ~limit in
        Ok (`List (List.map Domain.event_to_yojson events))
    | Wire.New_session ->
        if
          Hashtbl.length running_commands > 0
          || Hashtbl.length pending_permissions > 0
        then Error "the active session must be idle before creating another"
        else if !sessions_created_since_start >= 4 then
          (* TODO(tracer): Replace this in-adapter cap with one independently
             supervised worker per durable session before exposing unbounded
             session creation. pi-acp retains a Pi process for every session. *)
          Error "restart the worker before creating more than four sessions"
        else (
          status := Domain.Starting;
          let created = create_session () in
          harness_session_id := created;
          incr sessions_created_since_start;
          ignore
            (Store.append_event store ~kind:"timeline.reset"
               (`Assoc [ ("acpSessionId", `String created) ]));
          status := Domain.Idle;
          Ok (`Assoc [ ("sessionId", `String created) ]))
    | Wire.Prompt { command_id; text } -> (
        match Store.find_command store command_id with
        | Some state ->
            Ok
              (`Assoc
                 [
                   ("commandId", `String command_id);
                   ("state", `String (Domain.command_state_to_string state));
                   ("duplicate", `Bool true);
                 ])
        | None when Hashtbl.length running_commands > 0 ->
            Error "the session already has an active prompt"
        | None -> (
            let accepted =
              Store.accept_command store ~command_id ~request_id:command_id
                ~prompt:text
            in
            try
              status := Domain.Running;
              Store.set_command_state store ~command_id Domain.Dispatched;
              Hashtbl.replace running_commands command_id ();
              send
                (Acp.prompt_request ~delivery:None ~command_id
                   ~session_id:!harness_session_id ~text);
              Ok
                (`Assoc
                   [
                     ("commandId", `String command_id);
                     ("state", `String "dispatched");
                     ("duplicate", `Bool accepted.duplicate);
                   ])
            with exn ->
              status := Domain.Failed;
              Store.set_command_state store ~command_id Domain.Ambiguous;
              Error (Printexc.to_string exn)))
    | Wire.Deliver { command_id; text; action } -> (
        match Store.find_command store command_id with
        | Some state ->
            Ok
              (`Assoc
                 [
                   ("commandId", `String command_id);
                   ("state", `String (Domain.command_state_to_string state));
                   ("duplicate", `Bool true);
                 ])
        | None when Hashtbl.length running_commands = 0 ->
            Error (action ^ " is only available during an active prompt")
        | None -> (
            let accepted =
              Store.accept_command ~action store ~command_id
                ~request_id:command_id ~prompt:text
            in
            try
              status := Domain.Running;
              Store.set_command_state store ~command_id Domain.Dispatched;
              Hashtbl.replace running_commands command_id ();
              send
                (Acp.prompt_request ~delivery:(Some action) ~command_id
                   ~session_id:!harness_session_id ~text);
              Ok
                (`Assoc
                   [
                     ("commandId", `String command_id);
                     ("state", `String "dispatched");
                     ("action", `String action);
                     ("duplicate", `Bool accepted.duplicate);
                   ])
            with exn ->
              status := Domain.Failed;
              Store.set_command_state store ~command_id Domain.Ambiguous;
              Error (Printexc.to_string exn)))
    | Wire.Config_options -> Ok !config_options
    | Wire.Set_config_option { config_id; value } ->
        if
          Hashtbl.length running_commands > 0
          || Hashtbl.length pending_permissions > 0
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
            require_rpc_result ~id
              (Acp.set_config_option_request ~id ~session_id:!harness_session_id
                 ~config_id ~value)
          in
          (match Yojson.Safe.Util.member "configOptions" result with
          | `List _ as options -> config_options := options
          | _ -> ());
          ignore
            (Store.append_event store ~kind:"acp.config_option.changed" response);
          Ok (`Assoc [ ("configOptions", !config_options) ])
    | Wire.Cancel ->
        if Hashtbl.length running_commands = 0 then
          Error "the session has no active prompt"
        else (
          ignore
            (Store.append_event store ~kind:"command.cancel.requested"
               (`Assoc [ ("sessionId", `String !harness_session_id) ]));
          send (Acp.cancel_notification ~session_id:!harness_session_id);
          Ok (`Assoc [ ("state", `String "cancelling") ]))
    | Wire.Peer_event { kind; request_id; peer_id; text } ->
        let event =
          Store.append_event store ~kind
            (`Assoc
               [
                 ("requestId", `String request_id);
                 ("peerId", `String peer_id);
                 ("text", `String text);
               ])
        in
        Ok (Domain.event_to_yojson event)
    | Wire.Permission { request_id; option_id } -> (
        match Hashtbl.find_opt pending_permissions request_id with
        | None -> Error "permission request is no longer pending"
        | Some permission -> (
            match option_id with
            | Some selected
              when not (option_is_offered permission.params selected) ->
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
                  (Store.append_event store ~kind:"acp.permission.resolved"
                     (`Assoc
                        [
                          ("requestId", `String request_id);
                          ( "optionId",
                            Option.fold ~none:`Null
                              ~some:(fun value -> `String value)
                              selected );
                        ]));
                Hashtbl.remove pending_permissions request_id;
                send
                  (Acp.response_with_id ~id:permission.raw_id
                     (`Assoc [ ("outcome", outcome) ]));
                status :=
                  if Hashtbl.length running_commands > 0 then Domain.Running
                  else Domain.Idle;
                Ok (`Assoc [ ("resolved", `Bool true) ])))
  in
  let handle_connection flow _address =
    let reader = Eio.Buf_read.of_flow flow ~max_size:max_frame_bytes in
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
        let negotiation = handle_request hello in
        write_json flow (Wire.response_to_yojson negotiation);
        match negotiation with
        | Error _ -> ()
        | Ok _ -> (
            match receive () with
            | Ok request ->
                write_json flow
                  (Wire.response_to_yojson (handle_request request))
            | Error message ->
                write_json flow (Wire.response_to_yojson (Error message))))
    | Ok _ ->
        write_json flow
          (Wire.response_to_yojson
             (Error "hello must be the first request on a worker connection"))
    | Error message -> write_json flow (Wire.response_to_yojson (Error message))
  in
  let net = Eio.Stdenv.net env in
  (try Unix.unlink socket_path with Unix.Unix_error (Unix.ENOENT, _, _) -> ());
  let socket =
    Eio.Net.listen net ~sw ~backlog:32 ~reuse_addr:true (`Unix socket_path)
  in
  Unix.chmod socket_path 0o600;
  Printf.printf
    "worker_ready session=%s worker=%s pid=%d harness_pid=%d socket=%s\n%!"
    session_id worker_id (Unix.getpid ()) harness_pid socket_path;
  Eio.Net.run_server socket handle_connection
    ~on_error:(fun exn ->
      Format.eprintf "worker connection failed: %a@." Eio.Exn.pp exn)
    ~max_connections:32

let () =
  let socket_path = ref "" in
  let database_path = ref "" in
  let session_id = ref "tracer-session" in
  let worker_id = ref "tracer-worker" in
  let workspace = ref (Sys.getcwd ()) in
  let harness_command = ref "piss-mock-agent" in
  let harness_args = ref [] in
  let session_mcp = ref "" in
  let broker_url = ref "http://127.0.0.1:4318" in
  let broker_token = ref "" in
  let curl_command = ref "curl" in
  Arg.parse
    [
      ("--socket", Arg.Set_string socket_path, "Worker Unix socket path");
      ("--database", Arg.Set_string database_path, "Worker SQLite database path");
      ("--session", Arg.Set_string session_id, "PISS session ID");
      ("--worker", Arg.Set_string worker_id, "Worker ID");
      ("--workspace", Arg.Set_string workspace, "Authorized workspace");
      ( "--harness",
        Arg.Set_string harness_command,
        "Fixed ACP harness executable" );
      ( "--harness-arg",
        Arg.String (fun value -> harness_args := value :: !harness_args),
        "Fixed ACP harness argument (repeatable)" );
      ("--session-mcp", Arg.Set_string session_mcp, "PISS session MCP server");
      ("--broker-url", Arg.Set_string broker_url, "Loopback session broker URL");
      ("--broker-token", Arg.Set_string broker_token, "Session broker token");
      ("--curl-command", Arg.Set_string curl_command, "Fixed curl executable");
    ]
    (fun value -> raise (Arg.Bad ("unexpected argument: " ^ value)))
    "piss-session-worker";
  if !socket_path = "" then raise (Arg.Bad "--socket is required");
  if !database_path = "" then raise (Arg.Bad "--database is required");
  Eio_main.run @@ fun env ->
  run ~env ~socket_path:!socket_path ~database_path:!database_path
    ~session_id:!session_id ~worker_id:!worker_id ~workspace:!workspace
    ~harness_command:!harness_command ~harness_args:(List.rev !harness_args)
    ~session_mcp:!session_mcp ~broker_url:!broker_url
    ~broker_token:!broker_token ~curl_command:!curl_command
