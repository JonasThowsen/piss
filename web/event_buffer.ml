open! Core

type t = {
  history : Event_history.event list;
  history_sequences : Int64.Set.t;
  live : Event_history.event Int64.Map.t;
  live_capacity : int;
}

let create ~live_capacity history =
  if live_capacity < 1 then invalid_arg "live_capacity must be positive";
  let history_sequences =
    history |> List.map ~f:Event_history.sequence |> Int64.Set.of_list
  in
  { history; history_sequences; live = Int64.Map.empty; live_capacity }

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

let history_length t = List.length t.history
let live_length t = Map.length t.live
