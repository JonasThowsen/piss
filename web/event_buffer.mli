type t

val create : live_capacity:int -> Event_history.event list -> t
(** Keeps the initial history intact and bounds only events received live. *)

val add : t -> Event_history.event -> t
val events : t -> Event_history.event list
val entries : t -> Event_history.entry list
val highest_sequence : t -> int64
val history_length : t -> int
val live_length : t -> int
