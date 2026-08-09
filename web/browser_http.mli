open! Core
open! Async_kernel

val get :
  ?query:(string * string) list -> string -> string Or_error.t Deferred.t
(** Performs a browser GET against an encoded absolute same-origin path. *)

val post_json :
  ?query:(string * string) list ->
  string ->
  Yojson.Safe.t ->
  string Or_error.t Deferred.t
(** Performs a same-origin JSON POST with an explicit JSON content type. *)
