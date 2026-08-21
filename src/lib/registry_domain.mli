(** Pure, algebraic lifecycle states for the durable registry. SQLite text is
    decoded into these values by [Piss_registry.Registry]. *)

module Session_lifecycle : sig
  type t = Active | Finishing | Archived

  val transition : from:t -> t -> (t, string) result
end

module Peer_request_state : sig
  type t = Accepted | Queued | Dispatching | Dispatched | Completed | Failed

  val of_string : string -> (t, string) result
  val to_string : t -> string
  val is_terminal : t -> bool
  val transition : from:t -> t -> (t, string) result
end

module Subscription_state : sig
  type t = Pending | Dispatching | Delivered

  val of_string : string -> (t, string) result
  val to_string : t -> string
  val is_terminal : t -> bool
  val transition : from:t -> t -> (t, string) result
end

module Session_creation_state : sig
  type t = Pending | Launching | Cleanup | Active | Failed

  val of_string : string -> (t, string) result
  val to_string : t -> string
  val is_terminal : t -> bool
  val transition : from:t -> t -> (t, string) result
end
