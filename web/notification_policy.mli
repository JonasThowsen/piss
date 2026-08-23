type state = { status : Runtime_domain.status; last_finished_at : float option }

type notification =
  | Requires_action
  | Failed
  | Delegated_work_finished
  | Turn_finished of { delegated_work_remains : bool }

val decide : previous:state -> current:state -> notification option
