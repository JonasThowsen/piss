open! Bonsai_web.Cont

val input_id : string
val dispatch : unit Effect.t -> unit
val event_selection : 'a -> int -> int * int
val field_snapshot : string -> string * int * int
val apply_to_field : Mention_picker.insertion -> unit
val focus_selection : start:int -> stop:int -> unit
val focus_at : int -> unit
val key : 'a -> string
val event_bool : 'a -> string -> bool
val is_mobile : unit -> bool
val prevent : unit Effect.t -> unit Effect.t

val command_picker_view :
  Command_picker.active option ->
  Runtime_domain.available_command list ->
  selected:int ->
  on_hover:(int -> unit Effect.t) ->
  on_choose:(Runtime_domain.available_command -> unit Effect.t) ->
  Vdom.Node.t

val picker_view :
  Mention_picker.model ->
  on_hover:(int -> unit Effect.t) ->
  on_choose:(Mention_picker.resource -> unit Effect.t) ->
  Vdom.Node.t
