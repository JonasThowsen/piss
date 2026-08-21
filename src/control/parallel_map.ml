let map ~max_fibers operation values =
  if max_fibers < 1 then invalid_arg "max_fibers must be positive";
  let input = Array.of_list values in
  let length = Array.length input in
  let results = Array.make length None in
  let next_index = ref 0 in
  let take () =
    if !next_index >= length then None
    else
      let index = !next_index in
      incr next_index;
      Some (index, input.(index))
  in
  let rec worker () =
    match take () with
    | None -> ()
    | Some (index, value) ->
        results.(index) <- Some (operation value);
        worker ()
  in
  Eio.Switch.run (fun sw ->
      for _ = 1 to min max_fibers length do
        Eio.Fiber.fork ~sw worker
      done);
  Array.to_list results
  |> List.map (function
    | Some value -> value
    | None -> failwith "parallel operation did not complete")

let map_with_timeout ~clock ~timeout_seconds ~max_fibers ~on_timeout operation
    values =
  if timeout_seconds <= 0. then invalid_arg "timeout_seconds must be positive";
  map ~max_fibers
    (fun value ->
      try
        Eio.Time.with_timeout_exn clock timeout_seconds (fun () ->
            operation value)
      with Eio.Time.Timeout -> on_timeout value)
    values
