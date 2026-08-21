(* Unix-socket request handling for one session worker. *)

val handle :
  clock:_ Eio.Time.clock ->
  State.t ->
  Worker_prelude.Wire.request ->
  (Yojson.Safe.t, Worker_prelude.Error.t) result
(** Handle one decoded worker request against the abstract runtime state. *)
