(* Entry point for the pissd control plane. *)

let () =
  let started_at = Unix.gettimeofday () in
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
  let process_mgr = Eio.Stdenv.process_mgr stdenv in
  (match env.Config.workers with
  | Managed manager ->
      Workers.reconcile_session_creations ~process_mgr ~clock manager;
      Workers.reconcile_session_finishes ~process_mgr ~clock manager;
      Workers.start_registered ~process_mgr ~clock manager
  | Fixed _ -> ());
  let callback = Http.handler ~net ~clock ~process_mgr ~env in
  let server = Cohttp_eio.Server.make ~callback () in
  (match env.Config.workers with
  | Managed manager ->
      Eio.Fiber.fork ~sw (fun () -> Broker.supervise ~net ~clock manager);
      Eio.Fiber.fork ~sw (fun () ->
          let rec reconcile_cleanup () =
            Workers.reconcile_session_creations ~recover_launching:false
              ~process_mgr ~clock manager;
            Workers.reconcile_session_finishes ~process_mgr ~clock manager;
            Eio.Time.sleep clock 2.;
            reconcile_cleanup ()
          in
          reconcile_cleanup ())
  | Fixed _ -> ());
  Printf.printf
    "control_ready generation=%s pid=%d startup_ms=%.1f url=http://127.0.0.1:%d\n\
     %!"
    env.Config.generation (Unix.getpid ())
    ((Unix.gettimeofday () -. started_at) *. 1000.)
    port;
  Cohttp_eio.Server.run socket server ~on_error:(fun exn ->
      Format.eprintf "HTTP error: %a@." Eio.Exn.pp exn)
