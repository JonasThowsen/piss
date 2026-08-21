let invalid label from into =
  Error (Printf.sprintf "invalid %s transition from %s to %s" label from into)

module Session_lifecycle = struct
  type t = Active | Finishing | Archived

  let to_string = function
    | Active -> "active"
    | Finishing -> "finishing"
    | Archived -> "archived"

  let transition ~from into =
    match (from, into) with
    | Active, (Finishing | Archived)
    | Finishing, (Active | Archived)
    | Archived, Active ->
        Ok into
    | left, right when left = right -> Ok right
    | left, right ->
        invalid "session lifecycle" (to_string left) (to_string right)
end

module Peer_request_state = struct
  type t = Accepted | Queued | Dispatching | Dispatched | Completed | Failed

  let to_string = function
    | Accepted -> "accepted"
    | Queued -> "queued"
    | Dispatching -> "dispatching"
    | Dispatched -> "dispatched"
    | Completed -> "completed"
    | Failed -> "failed"

  let of_string = function
    | "accepted" -> Ok Accepted
    | "queued" -> Ok Queued
    | "dispatching" -> Ok Dispatching
    | "dispatched" -> Ok Dispatched
    | "completed" -> Ok Completed
    | "failed" -> Ok Failed
    | value -> Error ("unknown peer request state: " ^ value)

  let is_terminal = function Completed | Failed -> true | _ -> false

  let transition ~from into =
    match (from, into) with
    | Accepted, Dispatching
    | Queued, Dispatching
    | Dispatching, (Queued | Dispatched)
    | Dispatched, Dispatched
    | (Accepted | Queued | Dispatching | Dispatched), (Completed | Failed) ->
        Ok into
    | left, right when left = right -> Ok right
    | left, right -> invalid "peer request" (to_string left) (to_string right)
end

module Subscription_state = struct
  type t = Pending | Dispatching | Delivered

  let to_string = function
    | Pending -> "pending"
    | Dispatching -> "dispatching"
    | Delivered -> "delivered"

  let of_string = function
    | "pending" -> Ok Pending
    | "dispatching" -> Ok Dispatching
    | "delivered" -> Ok Delivered
    | value -> Error ("unknown subscription state: " ^ value)

  let is_terminal = function
    | Delivered -> true
    | Pending | Dispatching -> false

  let transition ~from into =
    match (from, into) with
    | Pending, Dispatching | Dispatching, Delivered | Pending, Delivered ->
        Ok into
    | left, right when left = right -> Ok right
    | left, right -> invalid "subscription" (to_string left) (to_string right)
end

module Session_creation_state = struct
  type t = Pending | Launching | Cleanup | Active | Failed

  let to_string = function
    | Pending -> "pending"
    | Launching -> "launching"
    | Cleanup -> "cleanup"
    | Active -> "active"
    | Failed -> "failed"

  let of_string = function
    | "pending" -> Ok Pending
    | "launching" -> Ok Launching
    | "cleanup" -> Ok Cleanup
    | "active" -> Ok Active
    | "failed" -> Ok Failed
    | value -> Error ("unknown session creation state: " ^ value)

  let is_terminal = function
    | Active | Failed -> true
    | Pending | Launching | Cleanup -> false

  let transition ~from into =
    match (from, into) with
    | Pending, Launching
    | Launching, Active
    | Pending, Cleanup
    | Launching, Cleanup
    | Pending, Failed
    | Launching, Failed
    | Cleanup, Failed ->
        Ok into
    | left, right when left = right -> Ok right
    | left, right ->
        invalid "session creation" (to_string left) (to_string right)
end
