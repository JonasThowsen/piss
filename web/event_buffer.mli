type t

val create : live_capacity:int -> Event_history.event list -> t
(** Keeps fetched history intact and bounds only events received live. *)

val add : t -> Event_history.event -> t
val prepend : t -> Event_history.event list -> (t, string) result
val begin_page : t -> t
val fail_page : t -> string -> t
val events : t -> Event_history.event list
val entries : t -> Event_history.entry list
val highest_sequence : t -> int64
val earliest_sequence : t -> int64 option
val can_page_before : t -> first_sequence:int64 -> bool
val is_loading : t -> bool
val page_error : t -> string option
val history_length : t -> int
val live_length : t -> int
