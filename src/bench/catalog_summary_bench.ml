let serial_map operation values = List.map operation values

let elapsed ~clock operation =
  let started = Eio.Time.now clock in
  let result = operation () in
  (Eio.Time.now clock -. started, result)

let () =
  Eio_main.run @@ fun env ->
  let clock = Eio.Stdenv.clock env in
  let sessions = List.init 64 Fun.id in
  let summary session =
    Eio.Time.sleep clock 0.01;
    session
  in
  let serial_seconds, serial =
    elapsed ~clock (fun () -> serial_map summary sessions)
  in
  let parallel_seconds, parallel =
    elapsed ~clock (fun () -> Parallel_map.map ~max_fibers:8 summary sessions)
  in
  if serial <> parallel then failwith "parallel catalog changed result order";
  let speedup = serial_seconds /. parallel_seconds in
  Printf.printf
    "catalog_summaries=64 socket_delay_ms=10 max_fibers=8 serial_ms=%.1f \
     parallel_ms=%.1f speedup=%.2fx\n\
     %!"
    (serial_seconds *. 1_000.)
    (parallel_seconds *. 1_000.)
    speedup;
  if parallel_seconds > 0.25 then (
    prerr_endline
      "catalog summary benchmark exceeded the 250 ms advisory budget";
    exit 1)
