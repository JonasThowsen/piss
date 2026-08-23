open! Core

type state = { status : Runtime_domain.status; last_finished_at : float option }

type notification =
  | Requires_action
  | Failed
  | Delegated_work_finished
  | Turn_finished of { delegated_work_remains : bool }

let finished_advanced previous current =
  match current with
  | None -> false
  | Some current ->
      Option.value_map previous ~default:true ~f:(fun previous ->
          Float.(current > previous))

let decide ~previous ~current =
  if
    phys_equal current.status Runtime_domain.Requires_action
    && not (phys_equal previous.status Runtime_domain.Requires_action)
  then Some Requires_action
  else if
    phys_equal current.status Runtime_domain.Failed
    && not (phys_equal previous.status Runtime_domain.Failed)
  then Some Failed
  else if
    phys_equal previous.status Runtime_domain.Waiting
    && phys_equal current.status Runtime_domain.Idle
  then Some Delegated_work_finished
  else if finished_advanced previous.last_finished_at current.last_finished_at
  then
    Some
      (Turn_finished
         {
           delegated_work_remains =
             phys_equal current.status Runtime_domain.Waiting;
         })
  else None
