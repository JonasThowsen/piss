open! Core

type t = Agent | Audit | Details

let all = [ Agent; Audit; Details ]

let label = function
  | Agent -> "Agent"
  | Audit -> "Audit"
  | Details -> "Details"

let id tab = String.lowercase (label tab)

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
