(** Bounded cooperative parallel map for control-plane fan-out. *)

val map : max_fibers:int -> ('a -> 'b) -> 'a list -> 'b list
(** Preserve input order while running at most [max_fibers] operations at once.
    The worker pool is work-conserving: a completed operation immediately takes
    the next input rather than waiting at a batch barrier. Must be called from
    an Eio runtime. *)

val map_with_timeout :
  clock:_ Eio.Time.clock ->
  timeout_seconds:float ->
  max_fibers:int ->
  on_timeout:('a -> 'b) ->
  ('a -> 'b) ->
  'a list ->
  'b list
(** As [map], but each operation has an independent monotonic Eio deadline.
    Timeout fallback is per item; other exceptions still cancel and propagate.
*)
