(* Unix-socket request handling for one session worker. *)

val handle : State.t -> Piss_core.Wire.request -> (Yojson.Safe.t, string) result
(** Handle one decoded worker request against the abstract runtime state. *)
