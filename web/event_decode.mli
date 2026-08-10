type t

val decode_events : string -> (t list, string) result
val decode_event : string -> (t, string) result
val sequence : t -> int64
val kind : t -> string
val update : t -> Timeline_projection.update option
val outbox_update : t -> Outbox_projection.update option
val accepted_command_id : t -> string option
val recovered_command_id : t -> string option
