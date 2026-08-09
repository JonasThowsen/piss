(* ACP harness process: spawn, write, read, and envelope dispatch. *)

(** A live harness process with its stdin, stdout, and a stable
    pid for the worker ledger. *)
type t = {
  pid : int;
  stdin : [ `Close | `Flow | `W ] Eio.Resource.t;
  stdout : Eio.Buf_read.t;
  send : Yojson.Safe.t -> unit;
}

(** Spawn the harness as [command] with [args] under [env]. The
    returned [t] holds the stdin sink (so the protocol can dispatch
    requests), a buffered stdout reader (so the protocol can parse
    envelopes), and the process pid (so the worker ledger can
    record which harness the events came from). *)
val spawn : sw:Eio.Switch.t -> env:Eio.Stdenv.t -> command:string -> args:string list -> t

(** Extract the [session/update] kind name from a harness envelope.
    Used to map every envelope to a stable event-kind string for the
    worker ledger. *)
val event_kind : Yojson.Safe.t -> string

(** True when [option_id] is one of the option ids offered by the
    permission request [params]. The worker rejects any user reply
    whose option id was not offered, so the harness cannot trick the
    user into picking an invalid choice. *)
val option_is_offered : params:Yojson.Safe.t -> option_id:string -> bool

(** Extract the `stopReason` field from a session/prompt response.
    The worker uses this to distinguish a cancelled prompt from a
    completed one without depending on the response shape. *)
val response_stop_reason : Yojson.Safe.t -> string option
