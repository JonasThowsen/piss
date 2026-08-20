(* Unix-socket request handling for one session worker. *)

val handle :
  clock:_ Eio.Time.clock ->
  State.t ->
  Piss_core.Wire.request ->
  (Yojson.Safe.t, Piss_core.Error.t) result
(** Handle one decoded worker request against the abstract runtime state. *)
