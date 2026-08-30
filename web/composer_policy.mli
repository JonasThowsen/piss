type state =
  | No_session
  | Connecting
  | Offline
  | Requires_action
  | Ready
  | Running
  | Submitting
  | Image_processing

val derive :
  has_session:bool ->
  runtime:Runtime_domain.t option ->
  connecting:bool ->
  submitting:bool ->
  image_processing:bool ->
  state

val disabled : state -> bool
val placeholder : state -> string

val action :
  Runtime_domain.status ->
  delivery:Prompt_command.action ->
  Prompt_command.action

val delivery_for_runtime :
  Runtime_domain.status ->
  delivery:Prompt_command.action ->
  Prompt_command.action
