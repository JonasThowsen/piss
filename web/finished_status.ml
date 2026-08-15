open! Core
open! Bonsai_web.Cont
open Js_of_ocaml
module Seen = String.Map

type t = float Seen.t

let storage_key = "piss:finished-seen"
let max_entries = 4096
let focus_listener : Js.Unsafe.any option ref = ref None
let visibility_listener : Js.Unsafe.any option ref = ref None
let storage () = Js.Unsafe.get (Js.Unsafe.inject Dom_html.window) "localStorage"

let read () =
  try
    let stored : Js.js_string Js.t Js.opt =
      Js.Unsafe.meth_call (storage ()) "getItem"
        [| Js.Unsafe.inject (Js.string storage_key) |]
    in
    match Js.Opt.to_option stored with
    | None -> Seen.empty
    | Some stored -> (
        match Yojson.Safe.from_string (Js.to_string stored) with
        | `Assoc entries ->
            List.foldi entries ~init:Seen.empty
              ~f:(fun index seen (id, value) ->
                if
                  index >= max_entries || String.is_empty id
                  || String.length id > 512
                then seen
                else
                  match value with
                  | `Float timestamp when Float.is_finite timestamp ->
                      Map.set seen ~key:id ~data:timestamp
                  | `Int timestamp ->
                      Map.set seen ~key:id ~data:(Float.of_int timestamp)
                  | _ -> seen)
        | _ -> Seen.empty)
  with _ -> Seen.empty

let write seen =
  try
    let entries =
      Map.to_alist seen
      |> List.sort ~compare:(fun (_, left) (_, right) ->
          Float.compare right left)
      |> fun entries -> List.take entries max_entries
    in
    let json =
      `Assoc
        (List.map entries ~f:(fun (id, timestamp) -> (id, `Float timestamp)))
      |> Yojson.Safe.to_string
    in
    ignore
      (Js.Unsafe.meth_call (storage ()) "setItem"
         [|
           Js.Unsafe.inject (Js.string storage_key);
           Js.Unsafe.inject (Js.string json);
         |])
  with _ -> ()

let acknowledge seen (session : Control_plane.Session.t) =
  let seen =
    Map.merge seen (read ()) ~f:(fun ~key:_ -> function
      | `Left timestamp | `Right timestamp -> Some timestamp
      | `Both (left, right) -> Some (Float.max left right))
  in
  match session.last_finished_at with
  | None -> seen
  | Some timestamp -> (
      match Map.find seen session.id with
      | Some acknowledged when Float.(acknowledged >= timestamp) -> seen
      | None | Some _ -> Map.set seen ~key:session.id ~data:timestamp)

let is_focused () =
  try
    let visibility =
      Js.to_string
        (Js.Unsafe.coerce
           (Js.Unsafe.get
              (Js.Unsafe.inject Dom_html.document)
              "visibilityState"))
    in
    let focused : bool Js.t =
      Js.Unsafe.meth_call (Js.Unsafe.inject Dom_html.document) "hasFocus" [||]
    in
    String.equal visibility "visible" && Js.to_bool focused
  with _ -> true

let remove_listener target event listener =
  ignore
    (Js.Unsafe.meth_call target "removeEventListener"
       [| Js.Unsafe.inject (Js.string event); listener |])

let cleanup () =
  Option.iter !focus_listener ~f:(fun listener ->
      remove_listener (Js.Unsafe.inject Dom_html.window) "focus" listener);
  Option.iter !visibility_listener ~f:(fun listener ->
      remove_listener
        (Js.Unsafe.inject Dom_html.document)
        "visibilitychange" listener);
  focus_listener := None;
  visibility_listener := None

let start ~on_focus =
  Effect.of_deferred_thunk (fun () ->
      cleanup ();
      let notify =
        Js.wrap_callback (fun _ -> if is_focused () then on_focus ())
        |> Js.Unsafe.inject
      in
      ignore
        (Js.Unsafe.meth_call
           (Js.Unsafe.inject Dom_html.window)
           "addEventListener"
           [| Js.Unsafe.inject (Js.string "focus"); notify |]);
      ignore
        (Js.Unsafe.meth_call
           (Js.Unsafe.inject Dom_html.document)
           "addEventListener"
           [| Js.Unsafe.inject (Js.string "visibilitychange"); notify |]);
      focus_listener := Some notify;
      visibility_listener := Some notify;
      Async_kernel.Deferred.return ())
