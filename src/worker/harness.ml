(* ACP harness process: spawn, write, read, and envelope dispatch. *)

let max_frame_bytes = Config.max_frame_bytes

let write_json sink json =
  Eio.Flow.copy_string (Yojson.Safe.to_string json ^ "\n") sink

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

let option_is_offered ~params ~option_id =
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

type t = {
  pid : int;
  stdin : [ `Close | `Flow | `W ] Eio.Resource.t;
  stdout : Eio.Buf_read.t;
  send : Yojson.Safe.t -> unit;
}

let spawn ~sw ~process_mgr ~stderr ~command ~args =
  let stdout, stdout_sink = Eio.Process.pipe ~sw process_mgr in
  let stdin_source, stdin_sink = Eio.Process.pipe ~sw process_mgr in
  let proc =
    Eio.Process.spawn ~sw process_mgr ~stdin:stdin_source ~stdout:stdout_sink
      ~stderr (command :: args)
  in
  Eio.Flow.close stdout_sink;
  Eio.Flow.close stdin_source;
  let pid = Eio.Process.pid proc in
  let reader = Eio.Buf_read.of_flow stdout ~max_size:max_frame_bytes in
  let outgoing = Eio.Stream.create 64 in
  let send json = Eio.Stream.add outgoing json in
  Eio.Fiber.fork ~sw (fun () ->
      while true do
        Eio.Stream.take outgoing |> write_json stdin_sink
      done);
  { pid; stdin = stdin_sink; stdout = reader; send }
