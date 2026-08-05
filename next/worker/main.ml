open Piss_core

let max_frame_bytes = 1024 * 1024

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
  | `String method_ -> "acp.request." ^ method_
  | _ -> "acp.response"

let run ~env ~socket_path ~database_path ~session_id ~worker_id ~workspace
    ~harness_command =
  let store =
    Store.open_ ~path:database_path ~session_id:(Domain.Session_id session_id)
      ~worker_id:(Domain.Worker_id worker_id)
  in
  Fun.protect ~finally:(fun () -> Store.close store) @@ fun () ->
  Eio.Switch.run @@ fun sw ->
  let process_mgr = Eio.Stdenv.process_mgr env in
  let harness_stdout, harness_stdout_sink = Eio.Process.pipe ~sw process_mgr in
  let harness_stdin_source, harness_stdin = Eio.Process.pipe ~sw process_mgr in
  let harness =
    Eio.Process.spawn ~sw process_mgr ~stdin:harness_stdin_source
      ~stdout:harness_stdout_sink ~stderr:(Eio.Stdenv.stderr env)
      [ harness_command ]
  in
  let harness_pid = Eio.Process.pid harness in
  let harness_reader =
    Eio.Buf_read.of_flow harness_stdout ~max_size:max_frame_bytes
  in
  write_json harness_stdin Acp.initialize_request;
  let initialize_response = read_json harness_reader in
  ignore (Store.append_event store ~kind:"acp.initialize" initialize_response);
  write_json harness_stdin (Acp.new_session_request ~cwd:workspace);
  let session_response = read_json harness_reader in
  let harness_session_id =
    match
      Yojson.Safe.Util.(
        session_response |> member "result" |> member "sessionId")
    with
    | `String value -> value
    | _ -> raise (Failure "ACP agent did not return a sessionId")
  in
  ignore (Store.append_event store ~kind:"acp.session.created" session_response);
  let status = ref Domain.Idle in
  let running_commands : (string, unit) Hashtbl.t = Hashtbl.create 16 in
  Eio.Fiber.fork ~sw (fun () ->
      try
        while true do
          let json = read_json harness_reader in
          ignore (Store.append_event store ~kind:(event_kind json) json);
          match Acp.envelope_of_yojson json with
          | Ok (Acp.Response { id; error = None; _ })
            when Hashtbl.mem running_commands id ->
              Hashtbl.remove running_commands id;
              Store.set_command_state store ~command_id:id Domain.Completed;
              status := Domain.Idle
          | Ok (Acp.Response { id; error = Some _; _ })
            when Hashtbl.mem running_commands id ->
              Hashtbl.remove running_commands id;
              Store.set_command_state store ~command_id:id Domain.Rejected;
              status := Domain.Idle
          | _ -> ()
        done
      with End_of_file ->
        status := Domain.Failed;
        ignore
          (Store.append_event store ~kind:"harness.disconnected"
             (`Assoc [ ("harnessPid", `Int harness_pid) ])));
  let worker_snapshot () =
    Domain.
      {
        session_id = Session_id session_id;
        worker_id = Worker_id worker_id;
        runtime_generation = Runtime_generation 1;
        worker_pid = Unix.getpid ();
        harness_pid = Some harness_pid;
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
               ("capabilities", `List [ `String "events"; `String "prompt" ]);
             ])
    | Wire.Hello { protocol_version } ->
        Error
          (Printf.sprintf "unsupported worker protocol version %d"
             protocol_version)
    | Wire.Snapshot -> Ok (Domain.snapshot_to_yojson (worker_snapshot ()))
    | Wire.Events { after; limit } ->
        let events = Store.list_events store ~after ~limit in
        Ok (`List (List.map Domain.event_to_yojson events))
    | Wire.Prompt { command_id; text } -> (
        let accepted =
          Store.accept_command store ~command_id ~request_id:command_id
            ~prompt:text
        in
        if accepted.duplicate then
          Ok
            (`Assoc
               [
                 ("commandId", `String command_id);
                 ( "state",
                   `String (Domain.command_state_to_string accepted.state) );
                 ("duplicate", `Bool true);
               ])
        else
          try
            status := Domain.Running;
            Store.set_command_state store ~command_id Domain.Dispatched;
            Hashtbl.replace running_commands command_id ();
            write_json harness_stdin
              (Acp.prompt_request ~command_id ~session_id:harness_session_id
                 ~text);
            Ok
              (`Assoc
                 [
                   ("commandId", `String command_id);
                   ("state", `String "dispatched");
                   ("duplicate", `Bool false);
                 ])
          with exn ->
            status := Domain.Failed;
            Store.set_command_state store ~command_id Domain.Ambiguous;
            Error (Printexc.to_string exn))
  in
  let handle_connection flow _address =
    let reader = Eio.Buf_read.of_flow flow ~max_size:max_frame_bytes in
    let response =
      try
        let json = read_json reader in
        match Wire.request_of_yojson json with
        | Ok request -> handle_request request
        | Error message -> Error message
      with
      | Yojson.Json_error message -> Error ("invalid JSON: " ^ message)
      | Eio.Buf_read.Buffer_limit_exceeded -> Error "worker frame is too large"
      | exn -> Error (Printexc.to_string exn)
    in
    write_json flow (Wire.response_to_yojson response)
  in
  let net = Eio.Stdenv.net env in
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
    ]
    (fun value -> raise (Arg.Bad ("unexpected argument: " ^ value)))
    "piss-session-worker";
  if !socket_path = "" then raise (Arg.Bad "--socket is required");
  if !database_path = "" then raise (Arg.Bad "--database is required");
  Eio_main.run @@ fun env ->
  run ~env ~socket_path:!socket_path ~database_path:!database_path
    ~session_id:!session_id ~worker_id:!worker_id ~workspace:!workspace
    ~harness_command:!harness_command
