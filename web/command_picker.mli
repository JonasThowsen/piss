type active = { query : string; stop : int }
type insertion = { text : string; cursor : int }

val max_query_length : int
(** Maximum command-name filter length accepted from the composer. *)

val active_at_cursor : text:string -> cursor:int -> active option
(** Parse a command filter only when the message's first character is [/]. *)

val matching_commands :
  query:string ->
  Runtime_domain.available_command list ->
  Runtime_domain.available_command list
(** Return available slash commands ordered by their match quality. *)

val insert_command :
  text:string ->
  active:active ->
  Runtime_domain.available_command ->
  insertion option
(** Replace the leading slash-command token while preserving its arguments. *)
