open! Core
open! Async_kernel

val get : string -> string Or_error.t Deferred.t
(** Performs a browser GET against an absolute same-origin path. *)
