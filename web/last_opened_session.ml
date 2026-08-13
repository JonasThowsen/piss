open! Core
open Js_of_ocaml

let storage_key = "piss:last-opened-session"
let max_session_id_length = 512
let storage () = Js.Unsafe.get (Js.Unsafe.inject Dom_html.window) "localStorage"

let remove () =
  ignore
    (Js.Unsafe.meth_call (storage ()) "removeItem"
       [| Js.Unsafe.inject (Js.string storage_key) |])

let read () =
  try
    let stored =
      Js.Unsafe.meth_call (storage ()) "getItem"
        [| Js.Unsafe.inject (Js.string storage_key) |]
    in
    let present : bool Js.t =
      Js.Unsafe.fun_call
        (Js.Unsafe.get (Js.Unsafe.inject Dom_html.window) "Boolean")
        [| stored |]
      |> Js.Unsafe.coerce
    in
    let value =
      if Js.to_bool present then Some (Js.to_string (Js.Unsafe.coerce stored))
      else None
    in
    match value with
    | Some session_id
      when (not (String.is_empty session_id))
           && String.length session_id <= max_session_id_length ->
        Some session_id
    | Some _ ->
        remove ();
        None
    | None -> None
  with _ -> None

let write = function
  | None -> ( try remove () with _ -> ())
  | Some session_id -> (
      if
        (not (String.is_empty session_id))
        && String.length session_id <= max_session_id_length
      then
        try
          ignore
            (Js.Unsafe.meth_call (storage ()) "setItem"
               [|
                 Js.Unsafe.inject (Js.string storage_key);
                 Js.Unsafe.inject (Js.string session_id);
               |])
        with _ -> ())
