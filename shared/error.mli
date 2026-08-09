(** Typed failures shared across the worker wire protocol and control plane. *)

type t =
  | Not_found of { resource : string; id : string }
  | Forbidden of { reason : string }
  | Conflict of { reason : string }
  | Upstream_unavailable of { message : string }
  | Validation of { field : string; reason : string }
  | Internal of { message : string }

val to_string : t -> string
(** Return a human-readable message suitable for logs and browser feedback. *)

val to_yojson : t -> Yojson.Safe.t
(** Encode the constructor and all structured fields as a JSON object. *)

val of_yojson : Yojson.Safe.t -> (t, string) result
(** Decode an error object, rejecting missing or malformed structured fields. *)
