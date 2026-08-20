open! Core

type paging = Idle | Loading | Exhausted | Failed of string

type t = {
  history : Event_history.event list;
  history_sequences : Int64.Set.t;
  live : Event_history.event Int64.Map.t;
  live_capacity : int;
  paging : paging;
  projection : Event_history.projection;
  entries : Event_history.entry list;
  projection_rebuilds : int;
  outbox_projection : Outbox_projection.projection;
  outbox : Outbox_projection.item list;
  highest_sequence : int64;
}

let ordered_events history live =
  List.merge history (Map.data live) ~compare:(fun left right ->
      Int64.compare (Event_history.sequence left) (Event_history.sequence right))

let project events rebuilds =
  let projection = Event_history.projection events in
  (projection, Event_history.projection_entries projection, rebuilds + 1)

let project_outbox events =
  let projection =
    events
    |> List.filter_map ~f:Event_history.outbox_update
    |> Outbox_projection.project_updates
  in
  (projection, Outbox_projection.items projection)

let create ~live_capacity history =
  if live_capacity < 1 then invalid_arg "live_capacity must be positive";
  let history_sequences =
    history |> List.map ~f:Event_history.sequence |> Int64.Set.of_list
  in
  let projection, entries, projection_rebuilds = project history 0 in
  let outbox_projection, outbox = project_outbox history in
  let highest_sequence =
    List.last history |> Option.value_map ~default:0L ~f:Event_history.sequence
  in
  {
    history;
    history_sequences;
    live = Int64.Map.empty;
    live_capacity;
    paging = Idle;
    projection;
    entries;
    projection_rebuilds;
    outbox_projection;
    outbox;
    highest_sequence;
  }

let trim_live live capacity =
  if Map.length live <= capacity then live
  else
    let batch = Int.min 256 (Int.max 1 (capacity / 16)) in
    let target = capacity + 1 - batch in
    let rec loop live =
      if Map.length live <= target then live
      else
        match Map.min_elt live with
        | None -> live
        | Some (sequence, _) -> loop (Map.remove live sequence)
    in
    loop live

let add t event =
  let sequence = Event_history.sequence event in
  if Set.mem t.history_sequences sequence || Map.mem t.live sequence then t
  else
    let untrimmed = Map.set t.live ~key:sequence ~data:event in
    let live = trim_live untrimmed t.live_capacity in
    let rebuild =
      Map.length live < Map.length untrimmed
      || Int64.(sequence <= t.highest_sequence)
    in
    let ordered = lazy (ordered_events t.history live) in
    let projection, entries, projection_rebuilds =
      if rebuild then project (Lazy.force ordered) t.projection_rebuilds
      else
        match Event_history.append_projection t.projection event with
        | None -> project (Lazy.force ordered) t.projection_rebuilds
        | Some projection ->
            ( projection,
              Event_history.projection_entries projection,
              t.projection_rebuilds )
    in
    let outbox_projection, outbox =
      if rebuild then project_outbox (Lazy.force ordered)
      else
        let projection =
          Option.value_map
            (Event_history.outbox_update event)
            ~default:t.outbox_projection
            ~f:(Outbox_projection.apply t.outbox_projection)
        in
        (projection, Outbox_projection.items projection)
    in
    let highest_sequence = Int64.max t.highest_sequence sequence in
    {
      t with
      live;
      projection;
      entries;
      projection_rebuilds;
      outbox_projection;
      outbox;
      highest_sequence;
    }

let strictly_increasing events =
  let rec loop previous = function
    | [] -> true
    | event :: rest ->
        let sequence = Event_history.sequence event in
        Int64.(sequence > previous) && loop sequence rest
  in
  loop Int64.min_value events

let prepend t page =
  if not (strictly_increasing page) then
    Error "event page sequences must be strictly increasing"
  else if List.is_empty page then Ok { t with paging = Exhausted }
  else
    let additions =
      List.filter page ~f:(fun event ->
          let sequence = Event_history.sequence event in
          not (Set.mem t.history_sequences sequence || Map.mem t.live sequence))
    in
    let history =
      List.merge additions t.history ~compare:(fun left right ->
          Int64.compare
            (Event_history.sequence left)
            (Event_history.sequence right))
    in
    let history_sequences =
      List.fold additions ~init:t.history_sequences ~f:(fun sequences event ->
          Set.add sequences (Event_history.sequence event))
    in
    let ordered = ordered_events history t.live in
    let projection, entries, projection_rebuilds =
      project ordered t.projection_rebuilds
    in
    let outbox_projection, outbox = project_outbox ordered in
    let highest_sequence =
      List.last history
      |> Option.value_map ~default:t.highest_sequence ~f:(fun event ->
          Int64.max t.highest_sequence (Event_history.sequence event))
    in
    Ok
      {
        t with
        history;
        history_sequences;
        paging = Idle;
        projection;
        entries;
        projection_rebuilds;
        outbox_projection;
        outbox;
        highest_sequence;
      }

let begin_page t =
  match t.paging with
  | Loading | Exhausted -> t
  | Idle | Failed _ -> { t with paging = Loading }

let fail_page t message = { t with paging = Failed message }
let events t = ordered_events t.history t.live
let entries t = t.entries
let outbox t = t.outbox
let highest_sequence t = t.highest_sequence

let earliest_sequence t =
  match (List.hd t.history, Map.min_elt t.live) with
  | None, None -> None
  | Some event, None -> Some (Event_history.sequence event)
  | None, Some (sequence, _) -> Some sequence
  | Some event, Some (sequence, _) ->
      Some (Int64.min (Event_history.sequence event) sequence)

let can_page_before t ~first_sequence =
  match (t.paging, earliest_sequence t) with
  | (Loading | Exhausted), _ | _, None -> false
  | (Idle | Failed _), Some earliest -> Int64.(earliest > first_sequence)

let is_loading t = phys_equal t.paging Loading

let page_error t =
  match t.paging with Failed message -> Some message | _ -> None

let history_length t = List.length t.history
let live_length t = Map.length t.live
let projection_rebuilds t = t.projection_rebuilds
