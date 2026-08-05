open Piss_core

let max_body_bytes = 128 * 1024
let max_frame_bytes = 1024 * 1024

let json_headers =
  Http.Header.of_list
    [
      ("content-type", "application/json; charset=utf-8");
      ("cache-control", "no-store");
      ("x-content-type-options", "nosniff");
    ]

let text_headers content_type =
  Http.Header.of_list
    [
      ("content-type", content_type);
      ("cache-control", "no-store");
      ("x-content-type-options", "nosniff");
    ]

let respond_json ?(status = `OK) json =
  Cohttp_eio.Server.respond_string ~status ~headers:json_headers
    ~body:(Yojson.Safe.to_string json)
    ()

let error_json ?(status = `Bad_request) message =
  respond_json ~status (`Assoc [ ("error", `String message) ])

let worker_request net socket_path request =
  Eio.Switch.run @@ fun sw ->
  let flow = Eio.Net.connect ~sw net (`Unix socket_path) in
  let reader = Eio.Buf_read.of_flow flow ~max_size:max_frame_bytes in
  let exchange request =
    Eio.Flow.copy_string (Yojson.Safe.to_string request ^ "\n") flow;
    Eio.Buf_read.line reader |> Yojson.Safe.from_string
    |> Wire.response_of_yojson
  in
  match
    exchange (`Assoc [ ("op", `String "hello"); ("protocolVersion", `Int 1) ])
  with
  | Error message -> Error ("worker negotiation failed: " ^ message)
  | Ok hello -> (
      match Yojson.Safe.Util.member "protocolVersion" hello with
      | `Int 1 -> exchange request
      | _ -> Error "worker selected an unsupported protocol version")

let parse_after uri =
  match Uri.get_query_param uri "after" with
  | None -> Ok 0L
  | Some value -> (
      try Ok (Int64.of_string value)
      with Failure _ -> Error "after must be a non-negative integer")

let read_body body =
  Eio.Buf_read.of_flow body ~max_size:max_body_bytes |> Eio.Buf_read.take_all

let safe_asset_path root resource =
  match resource with
  | "/" -> Some (Filename.concat root "index.html", "text/html; charset=utf-8")
  | "/styles.css" ->
      Some (Filename.concat root "styles.css", "text/css; charset=utf-8")
  | resource when String.starts_with ~prefix:"/fonts/" resource ->
      let name = Filename.basename resource in
      if
        name = resource || String.contains name '/' || String.contains name '\\'
      then None
      else
        let content_type =
          if Filename.extension name = ".ttf" then "font/ttf"
          else "text/plain; charset=utf-8"
        in
        Some (Filename.concat (Filename.concat root "fonts") name, content_type)
  | _ -> None

let serve_asset path content_type =
  try
    let channel = open_in_bin path in
    let body =
      Fun.protect
        ~finally:(fun () -> close_in_noerr channel)
        (fun () -> really_input_string channel (in_channel_length channel))
    in
    Cohttp_eio.Server.respond_string ~status:`OK
      ~headers:(text_headers content_type)
      ~body ()
  with Sys_error _ -> error_json ~status:`Not_found "asset not found"

let handler ~net ~worker_socket ~public_dir ~app_js ~generation _socket request
    body =
  let resource = Http.Request.resource request in
  let uri = Uri.of_string resource in
  let path = Uri.path uri in
  let method_ = Http.Request.meth request in
  try
    match (method_, path) with
    | `GET, "/health" ->
        respond_json
          (`Assoc
             [
               ("status", `String "ok");
               ("generation", `String generation);
               ("pid", `Int (Unix.getpid ()));
             ])
    | `GET, "/api/v2/session" -> (
        match
          worker_request net worker_socket
            (`Assoc [ ("op", `String "snapshot") ])
        with
        | Ok snapshot -> respond_json snapshot
        | Error message -> error_json ~status:`Service_unavailable message)
    | `GET, "/api/v2/events" -> (
        match parse_after uri with
        | Error message -> error_json message
        | Ok after -> (
            let request =
              `Assoc
                [
                  ("op", `String "events");
                  ("after", `Intlit (Int64.to_string after));
                  ("limit", `Int 200);
                ]
            in
            match worker_request net worker_socket request with
            | Ok events -> respond_json events
            | Error message -> error_json ~status:`Service_unavailable message))
    | `POST, "/api/v2/commands" -> (
        let json = read_body body |> Yojson.Safe.from_string in
        let open Yojson.Safe.Util in
        let command_id = json |> member "commandId" |> to_string in
        let text = json |> member "text" |> to_string in
        if command_id = "" || String.length command_id > 128 then
          error_json "commandId must contain between 1 and 128 characters"
        else if text = "" || String.length text > 64 * 1024 then
          error_json "text must contain between 1 and 65536 characters"
        else
          match
            worker_request net worker_socket
              (`Assoc
                 [
                   ("op", `String "prompt");
                   ("commandId", `String command_id);
                   ("text", `String text);
                 ])
          with
          | Ok result -> respond_json ~status:`Accepted result
          | Error message -> error_json ~status:`Service_unavailable message)
    | `GET, "/app.js" -> serve_asset app_js "text/javascript; charset=utf-8"
    | `GET, resource -> (
        match safe_asset_path public_dir resource with
        | Some (path, content_type) -> serve_asset path content_type
        | None -> error_json ~status:`Not_found "not found")
    | _ -> error_json ~status:`Method_not_allowed "method not allowed"
  with
  | Eio.Io _ as exn ->
      error_json ~status:`Service_unavailable (Printexc.to_string exn)
  | Eio.Buf_read.Buffer_limit_exceeded ->
      error_json ~status:`Request_entity_too_large "request body is too large"
  | Yojson.Json_error message -> error_json ("invalid JSON: " ^ message)
  | Yojson.Safe.Util.Type_error (message, _) -> error_json message
  | exn -> error_json ~status:`Internal_server_error (Printexc.to_string exn)

let () =
  let port = ref 4318 in
  let worker_socket = ref "" in
  let public_dir = ref "web-next/public" in
  let app_js = ref "_build/default/web-next/app.js" in
  let generation = ref "development" in
  Arg.parse
    [
      ("--port", Arg.Set_int port, "Loopback HTTP port");
      ("--worker-socket", Arg.Set_string worker_socket, "Session worker socket");
      ("--public", Arg.Set_string public_dir, "Browser public directory");
      ("--app-js", Arg.Set_string app_js, "Melange application module");
      ( "--generation",
        Arg.Set_string generation,
        "Immutable control-plane generation" );
    ]
    (fun value -> raise (Arg.Bad ("unexpected argument: " ^ value)))
    "pissd-next";
  if !worker_socket = "" then raise (Arg.Bad "--worker-socket is required");
  Eio_main.run @@ fun env ->
  Eio.Switch.run @@ fun sw ->
  let socket =
    Eio.Net.listen (Eio.Stdenv.net env) ~sw ~backlog:128 ~reuse_addr:true
      (`Tcp (Eio.Net.Ipaddr.V4.loopback, !port))
  in
  let callback =
    handler ~net:(Eio.Stdenv.net env) ~worker_socket:!worker_socket
      ~public_dir:!public_dir ~app_js:!app_js ~generation:!generation
  in
  let server = Cohttp_eio.Server.make ~callback () in
  Printf.printf "control_ready generation=%s pid=%d url=http://127.0.0.1:%d\n%!"
    !generation (Unix.getpid ()) !port;
  Cohttp_eio.Server.run socket server ~on_error:(fun exn ->
      Format.eprintf "HTTP error: %a@." Eio.Exn.pp exn)
