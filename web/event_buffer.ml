open! Core

type paging = Idle | Loading | Exhausted | Failed of string

type t = {
  history : Event_history.event list;
  history_sequences : Int64.Set.t;
  live : Event_history.event Int64.Map.t;
  live_capacity : int;
  paging : paging;
}

let create ~live_capacity history =
  if live_capacity < 1 then invalid_arg "live_capacity must be positive";
  let history_sequences =
    history |> List.map ~f:Event_history.sequence |> Int64.Set.of_list
  in
  {
    history;
    history_sequences;
    live = Int64.Map.empty;
    live_capacity;
    paging = Idle;
  }

let trim_live live capacity =
  let rec loop live =
    if Map.length live <= capacity then live
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
    {
      t with
      live =
        ( Map.set t.live ~key:sequence ~data:event |> fun live ->
          trim_live live t.live_capacity );
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
    Ok { t with history; history_sequences; paging = Idle }

let begin_page t =
  match t.paging with
  | Loading | Exhausted -> t
  | Idle | Failed _ -> { t with paging = Loading }

let fail_page t message = { t with paging = Failed message }

let events t =
  List.merge t.history (Map.data t.live) ~compare:(fun left right ->
      Int64.compare (Event_history.sequence left) (Event_history.sequence right))

let entries t = Event_history.project (events t)

let highest_sequence t =
  let history_highest =
    List.last t.history
    |> Option.value_map ~default:0L ~f:Event_history.sequence
  in
  Map.max_elt t.live
  |> Option.value_map ~default:history_highest ~f:(fun (sequence, _) ->
      Int64.max history_highest sequence)

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
