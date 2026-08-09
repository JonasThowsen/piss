type selection

val select : session_id:string -> selection
(** Closes the prior source and invalidates its callbacks. *)

val connect :
  selection ->
  after:int64 ->
  on_event:(string -> unit) ->
  on_open:(unit -> unit) ->
  on_error:(unit -> unit) ->
  (unit, string) result
(** Opens one native same-origin EventSource. The browser owns retry timing and
    Last-Event-ID resumption. A stale selection is ignored. *)

val close : unit -> unit
