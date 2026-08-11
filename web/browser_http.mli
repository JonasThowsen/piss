open! Core
open! Async_kernel

type error_kind =
  | Not_found
  | Forbidden
  | Conflict
  | Upstream_unavailable
  | Validation
  | Internal
  | Unknown of string

type post_error = {
  status : int option;
  kind : error_kind option;
  message : string;
}

val error_message : post_error -> string
val is_conflict : post_error -> bool
val is_stale_runtime_conflict : post_error -> bool
val is_authoritative_terminal : post_error -> bool

val get :
  ?query:(string * string) list -> string -> string Or_error.t Deferred.t
(** Performs a browser GET against an encoded absolute same-origin path. *)

val get_cancelable :
  ?query:(string * string) list ->
  string ->
  string Or_error.t Deferred.t * (unit -> unit)
(** Performs a browser GET and returns a function that aborts it. *)

val post_json_typed :
  ?query:(string * string) list ->
  string ->
  Yojson.Safe.t ->
  (string, post_error) Result.t Deferred.t
(** Performs a JSON POST while retaining typed HTTP errors and status. *)

val post_json :
  ?query:(string * string) list ->
  string ->
  Yojson.Safe.t ->
  string Or_error.t Deferred.t
(** Compatibility wrapper for callers that only need a human-readable error. *)
