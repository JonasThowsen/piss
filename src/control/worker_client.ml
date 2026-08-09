(* Client for the worker-side wire protocol over a Unix-domain socket. *)

open Piss_core

let request ~net ~socket request =
  try
    Eio.Switch.run @@ fun sw ->
    let flow = Eio.Net.connect ~sw net (`Unix socket) in
    let reader = Eio.Buf_read.of_flow flow ~max_size:Config.max_frame_bytes in
    let exchange request =
      Eio.Flow.copy_string (Yojson.Safe.to_string request ^ "\n") flow;
      Eio.Buf_read.line reader |> Yojson.Safe.from_string
      |> Wire.response_of_yojson
    in
    match
      exchange (`Assoc [ ("op", `String "hello"); ("protocolVersion", `Int 1) ])
    with
    | Error error ->
        Error
          (Error.Upstream_unavailable
             { message = "worker negotiation failed: " ^ Error.to_string error })
    | Ok hello -> (
        match Yojson.Safe.Util.member "protocolVersion" hello with
        | `Int 1 -> exchange request
        | _ ->
            Error
              (Error.Upstream_unavailable
                 { message = "worker selected an unsupported protocol version" })
        )
  with exn ->
    Error (Error.Upstream_unavailable { message = Printexc.to_string exn })
