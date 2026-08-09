open! Core

type t = Agent | Working | Details

let all = [ Agent; Working; Details ]

let label = function
  | Agent -> "Agent"
  | Working -> "Working"
  | Details -> "Details"

let id tab = String.lowercase (label tab)

let select_after_snapshot ~previous ~next current =
  match (previous, next, current) with
  | Some previous, Runtime_domain.Running, Agent
    when not (phys_equal previous Runtime_domain.Running) ->
      Working
  | _ -> current

let navigate ~current ~key =
  let index =
    List.findi all ~f:(fun _ candidate -> phys_equal candidate current)
    |> Option.value_map ~default:0 ~f:fst
  in
  match key with
  | "ArrowRight" -> Some (List.nth_exn all ((index + 1) mod List.length all))
  | "ArrowLeft" ->
      Some
        (List.nth_exn all ((index + List.length all - 1) mod List.length all))
  | "Home" -> Some (List.hd_exn all)
  | "End" -> Some (List.last_exn all)
  | _ -> None
