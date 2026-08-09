(* Server-sent events source for the live session timeline. *)

module Source = struct
  type t = {
    fetch : int64 -> (Yojson.Safe.t list, string) result;
    sleep : float -> unit;
    mutable cursor : int64;
    mutable pending : string;
    mutable offset : int;
    mutable last_heartbeat : float;
  }

  let sequence event =
    match Yojson.Safe.Util.member "sequence" event with
    | `Int value -> Some (Int64.of_int value)
    | `Intlit value -> Int64.of_string_opt value
    | _ -> None

  let frame event =
    match sequence event with
    | None -> None
    | Some id ->
        Some
          ( id,
            Printf.sprintf "id: %Ld\ndata: %s\n\n" id
              (Yojson.Safe.to_string event) )

  let rec refill stream =
    match stream.fetch stream.cursor with
    | Error _ -> raise End_of_file
    | Ok events ->
        let frames = List.filter_map frame events in
        if List.length frames <> List.length events then raise End_of_file
        else if frames <> [] then (
          stream.cursor <-
            List.fold_left
              (fun cursor (id, _) -> Int64.max cursor id)
              stream.cursor frames;
          stream.pending <- frames |> List.map snd |> String.concat "";
          stream.offset <- 0)
        else if Unix.gettimeofday () -. stream.last_heartbeat >= 15. then (
          stream.pending <- ": keep-alive\n\n";
          stream.offset <- 0;
          stream.last_heartbeat <- Unix.gettimeofday ())
        else (
          stream.sleep 0.25;
          refill stream)

  let single_read stream target =
    if stream.offset >= String.length stream.pending then refill stream;
    let length =
      min (Cstruct.length target) (String.length stream.pending - stream.offset)
    in
    Cstruct.blit_from_string stream.pending stream.offset target 0 length;
    stream.offset <- stream.offset + length;
    length

  let read_methods = []
end

let source ~fetch ~sleep ~after =
  let operations = Eio.Flow.Pi.source (module Source) in
  Eio.Resource.T
    ( Source.
        {
          fetch;
          sleep;
          cursor = after;
          pending = "retry: 1000\n\n";
          offset = 0;
          last_heartbeat = Unix.gettimeofday ();
        },
      operations )
