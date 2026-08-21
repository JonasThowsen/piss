let () =
  Eio_main.run @@ fun env ->
  let clock = Eio.Stdenv.clock env in
  let active = Atomic.make 0 in
  let peak = Atomic.make 0 in
  let update_peak value =
    let rec loop () =
      let seen = Atomic.get peak in
      if value <= seen || Atomic.compare_and_set peak seen value then ()
      else loop ()
    in
    loop ()
  in
  let operation value =
    let current = Atomic.fetch_and_add active 1 + 1 in
    update_peak current;
    Eio.Time.sleep clock 0.005;
    ignore (Atomic.fetch_and_add active (-1));
    value * value
  in
  let input = List.init 32 Fun.id in
  let output = Parallel_map.map ~max_fibers:4 operation input in
  Alcotest.(check (list int))
    "input order"
    (List.map (fun n -> n * n) input)
    output;
  Alcotest.(check bool) "parallel work happened" true (Atomic.get peak > 1);
  Alcotest.(check bool) "fan-out stayed bounded" true (Atomic.get peak <= 4);
  Alcotest.(check (list int))
    "empty input" []
    (Parallel_map.map ~max_fibers:4 operation []);
  Alcotest.(check bool)
    "invalid bound rejected" true
    (match Parallel_map.map ~max_fibers:0 operation [ 1 ] with
    | exception Invalid_argument _ -> true
    | _ -> false);
  Alcotest.(check bool)
    "child exception propagates" true
    (match
       Parallel_map.map ~max_fibers:4
         (fun value ->
           if value = 3 then failwith "summary failed";
           Eio.Time.sleep clock 0.001;
           value)
         [ 1; 2; 3; 4 ]
     with
    | exception Failure message -> String.equal message "summary failed"
    | _ -> false);
  let release, release_resolver = Eio.Promise.create () in
  let fast_done, fast_done_resolver = Eio.Promise.create () in
  let mapped, mapped_resolver = Eio.Promise.create () in
  let fast_count = ref 0 in
  Eio.Switch.run (fun sw ->
      Eio.Fiber.fork ~sw (fun () ->
          let result =
            Parallel_map.map ~max_fibers:2
              (fun value ->
                if value = 0 then Eio.Promise.await release
                else (
                  incr fast_count;
                  if !fast_count = 4 then
                    ignore (Eio.Promise.try_resolve fast_done_resolver ());
                  value))
              [ 0; 1; 2; 3; 4 ]
          in
          Eio.Promise.resolve mapped_resolver result);
      let work_conserving =
        try
          Eio.Time.with_timeout_exn clock 1. (fun () ->
              Eio.Promise.await fast_done);
          true
        with Eio.Time.Timeout -> false
      in
      ignore (Eio.Promise.try_resolve release_resolver 0);
      Alcotest.(check bool)
        "stalled item does not create a batch barrier" true work_conserving;
      Alcotest.(check (list int))
        "work-conserving order" [ 0; 1; 2; 3; 4 ] (Eio.Promise.await mapped));
  let never, _never_resolver = Eio.Promise.create () in
  let timed =
    Parallel_map.map_with_timeout ~clock ~timeout_seconds:0.01 ~max_fibers:2
      ~on_timeout:(fun value -> -value)
      (fun value -> if value = 2 then Eio.Promise.await never else value)
      [ 1; 2; 3 ]
  in
  Alcotest.(check (list int))
    "stalled worker gets per-item fallback" [ 1; -2; 3 ] timed
