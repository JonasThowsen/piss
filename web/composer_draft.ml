open! Core
open Js_of_ocaml

let storage_key_prefix = "piss:composer-draft:"
let max_session_id_length = 512
let max_draft_length = 65536
let storage () = Js.Unsafe.get (Js.Unsafe.inject Dom_html.window) "localStorage"

let valid_session_id session_id =
  (not (String.is_empty session_id))
  && String.length session_id <= max_session_id_length

let storage_key session_id = storage_key_prefix ^ session_id

let remove session_id =
  if valid_session_id session_id then
    try
      ignore
        (Js.Unsafe.meth_call (storage ()) "removeItem"
           [| Js.Unsafe.inject (Js.string (storage_key session_id)) |])
    with _ -> ()

let read session_id =
  if not (valid_session_id session_id) then None
  else
    try
      let stored : Js.js_string Js.t Js.opt =
        Js.Unsafe.meth_call (storage ()) "getItem"
          [| Js.Unsafe.inject (Js.string (storage_key session_id)) |]
      in
      match Js.Opt.to_option stored with
      | None -> None
      | Some stored ->
          let draft = Js.to_string stored in
          if String.length draft <= max_draft_length then Some draft
          else (
            remove session_id;
            None)
    with _ -> None

let write session_id draft =
  if valid_session_id session_id then
    if String.is_empty draft then remove session_id
    else if String.length draft <= max_draft_length then
      try
        ignore
          (Js.Unsafe.meth_call (storage ()) "setItem"
             [|
               Js.Unsafe.inject (Js.string (storage_key session_id));
               Js.Unsafe.inject (Js.string draft);
             |])
      with _ -> ()
