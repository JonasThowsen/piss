(* Client for the worker-side wire protocol over a Unix-domain socket. *)

open Piss_core

type attempt = Before_request of Error.t | Complete of Wire.response

let upstream message = Error.Upstream_unavailable { message }

type legacy_operation = Fenced | Drain | Compatible

let legacy_operation request =
  match Yojson.Safe.Util.member "op" request with
  | `String ("prompt" | "deliver" | "recover_command" | "set_config_option") ->
      Fenced
  | `String ("cancel" | "permission") -> Drain
  | _ -> Compatible

let runtime_target request =
  match Yojson.Safe.Util.member "target" request with
  | `Assoc _ as target -> Some target
  | _ -> None

let legacy_target_matches ~snapshot target =
  let member name json = Yojson.Safe.Util.member name json in
  Yojson.Safe.equal (member "sessionId" snapshot) (member "sessionId" target)
  && Yojson.Safe.equal (member "workerId" snapshot) (member "workerId" target)
  && Yojson.Safe.equal
       (member "runtimeGeneration" snapshot)
       (member "runtimeGeneration" target)

let request_with_version ~net ~socket ~protocol_version request =
  let request_sent = ref false in
  try
    Eio.Switch.run @@ fun sw ->
    let flow = Eio.Net.connect ~sw net (`Unix socket) in
    let reader =
      Eio.Buf_read.of_flow flow ~max_size:Config.max_worker_response_bytes
    in
    let exchange request =
      Eio.Flow.copy_string (Yojson.Safe.to_string request ^ "\n") flow;
      Eio.Buf_read.line reader |> Yojson.Safe.from_string
      |> Wire.response_of_yojson
    in
    match
      exchange
        (`Assoc
           [
             ("op", `String "hello"); ("protocolVersion", `Int protocol_version);
           ])
    with
    | Error error -> Before_request error
    | Ok hello -> (
        match Yojson.Safe.Util.member "protocolVersion" hello with
        | `Int selected when selected = protocol_version ->
            request_sent := true;
            Complete (exchange request)
        | _ ->
            Before_request
              (upstream "worker selected an unsupported protocol version"))
  with exn ->
    let error = upstream (Printexc.to_string exn) in
    if !request_sent then Complete (Error error) else Before_request error

let request ~net ~socket request =
  match request_with_version ~net ~socket ~protocol_version:2 request with
  | Complete response -> response
  | Before_request version_two_error -> (
      let request_v1 request =
        match request_with_version ~net ~socket ~protocol_version:1 request with
        | Complete response -> response
        | Before_request version_one_error ->
            Error
              (upstream
                 ("worker negotiation failed: "
                 ^ Error.to_string version_one_error))
      in
      match legacy_operation request with
      | Compatible -> request_v1 request
      | Fenced ->
          Error
            (upstream
               ("worker protocol v2 is required for runtime mutations: "
               ^ Error.to_string version_two_error))
      | Drain -> (
          (* A v1 worker may need a cancellation or permission decision before
             it can become idle and upgrade. No new command can enter while the
             control plane is in this compatibility mode. *)
          match runtime_target request with
          | None ->
              Error
                (upstream "runtime target is required for legacy worker drain")
          | Some target -> (
              match
                request_with_version ~net ~socket ~protocol_version:1
                  (`Assoc [ ("op", `String "snapshot") ])
              with
              | Complete (Ok snapshot)
                when legacy_target_matches ~snapshot target ->
                  request_v1 request
              | Complete (Ok _) ->
                  Error
                    (Error.Conflict
                       {
                         reason =
                           "stale runtime target: worker incarnation changed";
                       })
              | Complete (Error error) -> Error error
              | Before_request error -> Error error)))
