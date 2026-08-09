open! Core
open! Async_kernel

let get path =
  if
    String.is_prefix path ~prefix:"/"
    && not (String.is_prefix path ~prefix:"//")
  then Async_js.Http.get path
  else Deferred.return (Or_error.error_string "HTTP path must be same-origin")
