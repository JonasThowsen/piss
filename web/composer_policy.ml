type state =
  | No_session
  | Connecting
  | Offline
  | Requires_action
  | Ready
  | Running
  | Submitting
  | Image_processing

let derive ~has_session ~runtime ~connecting ~submitting ~image_processing =
  if not has_session then No_session
  else if image_processing then Image_processing
  else if submitting then Submitting
  else if connecting then Connecting
  else
    match runtime with
    | None -> Offline
    | Some runtime -> (
        match runtime.Runtime_domain.status with
        | Idle | Waiting -> Ready
        | Running -> Running
        | Requires_action -> Requires_action
        | Starting -> Connecting
        | Stopped | Failed | Offline | Archived -> Offline)

let disabled = function
  | Ready | Running -> false
  | No_session | Connecting | Offline | Requires_action | Submitting
  | Image_processing ->
      true

let placeholder = function
  | No_session -> "Select a session to compose"
  | Connecting -> "Connecting to runtime..."
  | Offline -> "This runtime is not available"
  | Requires_action -> "Resolve the pending permission to continue"
  | Submitting -> "Submitting message..."
  | Image_processing -> "Processing image attachments..."
  | Ready -> "Message agent"
  | Running -> "Guide the active run"

let action status ~delivery =
  match status with
  | Runtime_domain.Running -> delivery
  | _ -> Prompt_command.Prompt
