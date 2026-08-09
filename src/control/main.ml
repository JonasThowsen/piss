(* Entry point for the pissd control plane. *)

let () =
  let env, close_registry, port = Config.parse () in
  Fun.protect ~finally:close_registry @@ fun () ->
  Eio_main.run @@ fun stdenv ->
  Eio.Switch.run @@ fun sw ->
  let socket =
    Eio.Net.listen (Eio.Stdenv.net stdenv) ~sw ~backlog:128 ~reuse_addr:true
      (`Tcp (Eio.Net.Ipaddr.V4.loopback, port))
  in
  let net = Eio.Stdenv.net stdenv in
  let clock = Eio.Stdenv.clock stdenv in
  let callback = Http.handler ~net ~clock ~env in
  let server = Cohttp_eio.Server.make ~callback () in
  (match env.Config.workers with
  | Managed manager ->
      Eio.Fiber.fork ~sw (fun () -> Broker.supervise ~net ~clock manager)
  | Fixed _ -> ());
  Printf.printf "control_ready generation=%s pid=%d url=http://127.0.0.1:%d\n%!"
    env.Config.generation (Unix.getpid ()) port;
  Cohttp_eio.Server.run socket server ~on_error:(fun exn ->
      Format.eprintf "HTTP error: %a@." Eio.Exn.pp exn)
