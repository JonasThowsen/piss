open! Core
open! Bonsai_web.Cont
open Js_of_ocaml

let timeline : Js.Unsafe.any option ref = ref None
let mutation : Js.Unsafe.any option ref = ref None
let resize : Js.Unsafe.any option ref = ref None
let frame : Js.Unsafe.any option ref = ref None
let settle_frame : Js.Unsafe.any option ref = ref None
let listener : Js.Unsafe.any option ref = ref None
let window_listener : Js.Unsafe.any option ref = ref None
let following = ref true
let pinning = ref false
let previous_top = ref 0

let present value =
  Js.to_bool
    (Js.Unsafe.coerce
       (Js.Unsafe.fun_call
          (Js.Unsafe.get (Js.Unsafe.inject Dom_html.window) "Boolean")
          [| value |]))

let request_frame callback =
  let wrapped = Js.wrap_callback callback in
  Js.Unsafe.meth_call
    (Js.Unsafe.inject Dom_html.window)
    "requestAnimationFrame"
    [| Js.Unsafe.inject wrapped |]

let cancel_frame () =
  Option.iter !frame ~f:(fun value ->
      ignore
        (Js.Unsafe.meth_call
           (Js.Unsafe.inject Dom_html.window)
           "cancelAnimationFrame" [| value |]));
  frame := None

let cancel_settle_frame () =
  Option.iter !settle_frame ~f:(fun value ->
      ignore
        (Js.Unsafe.meth_call
           (Js.Unsafe.inject Dom_html.window)
           "cancelAnimationFrame" [| value |]));
  settle_frame := None

let button () =
  let document = Js.Unsafe.inject Dom_html.document in
  let value =
    Js.Unsafe.meth_call document "querySelector"
      [|
        Js.Unsafe.inject (Js.string "[aria-label=\"Jump to latest message\"]");
      |]
  in
  if present value then Some value else None

let update_button () =
  Option.iter (button ()) ~f:(fun value ->
      Js.Unsafe.set value "hidden" !following)

let distance value =
  let height : int = Js.Unsafe.get value "scrollHeight" in
  let top : int = Js.Unsafe.get value "scrollTop" in
  let client : int = Js.Unsafe.get value "clientHeight" in
  height - top - client

let rec pin () =
  frame := None;
  match !timeline with
  | None -> ()
  | Some value when !following ->
      pinning := true;
      let height : int = Js.Unsafe.get value "scrollHeight" in
      Js.Unsafe.set value "scrollTop" height;
      previous_top := Js.Unsafe.get value "scrollTop";
      cancel_settle_frame ();
      settle_frame :=
        Some
          (request_frame (fun () ->
               settle_frame := None;
               pinning := false;
               if !following then (
                 let height : int = Js.Unsafe.get value "scrollHeight" in
                 Js.Unsafe.set value "scrollTop" height;
                 previous_top := Js.Unsafe.get value "scrollTop");
               update_button ()))
  | Some _ -> update_button ()

and schedule () =
  if Option.is_none !frame then (
    if !following then pinning := true;
    frame := Some (request_frame pin))

let on_scroll () =
  match !timeline with
  | None -> ()
  | Some value ->
      let top : int = Js.Unsafe.get value "scrollTop" in
      if not !pinning then
        if top < !previous_top - 1 then following := false
        else following := distance value <= 80;
      previous_top := top;
      update_button ()

let cleanup_now () =
  cancel_frame ();
  cancel_settle_frame ();
  Option.iter !mutation ~f:(fun value ->
      ignore (Js.Unsafe.meth_call value "disconnect" [||]));
  Option.iter !resize ~f:(fun value ->
      ignore (Js.Unsafe.meth_call value "disconnect" [||]));
  Option.iter !timeline ~f:(fun value ->
      Option.iter !listener ~f:(fun callback ->
          ignore
            (Js.Unsafe.meth_call value "removeEventListener"
               [| Js.Unsafe.inject (Js.string "scroll"); callback |])));
  Option.iter !window_listener ~f:(fun callback ->
      ignore
        (Js.Unsafe.meth_call
           (Js.Unsafe.inject Dom_html.window)
           "removeEventListener"
           [| Js.Unsafe.inject (Js.string "resize"); callback |]));
  mutation := None;
  resize := None;
  listener := None;
  window_listener := None;
  timeline := None

let observe constructor_name =
  let callback = Js.wrap_callback (fun _ -> schedule ()) in
  let constructor =
    Js.Unsafe.get (Js.Unsafe.inject Dom_html.window) constructor_name
  in
  if present constructor then
    Some (Js.Unsafe.new_obj constructor [| Js.Unsafe.inject callback |])
  else None

let install () =
  frame := None;
  let document = Js.Unsafe.inject Dom_html.document in
  let value =
    Js.Unsafe.meth_call document "getElementById"
      [| Js.Unsafe.inject (Js.string "timeline") |]
  in
  if present value then (
    timeline := Some value;
    previous_top := Js.Unsafe.get value "scrollTop";
    let callback = Js.wrap_callback (fun _ -> on_scroll ()) in
    let callback_any = Js.Unsafe.inject callback in
    listener := Some callback_any;
    ignore
      (Js.Unsafe.meth_call value "addEventListener"
         [| Js.Unsafe.inject (Js.string "scroll"); callback_any |]);
    let resize_callback = Js.wrap_callback (fun _ -> schedule ()) in
    let resize_callback_any = Js.Unsafe.inject resize_callback in
    window_listener := Some resize_callback_any;
    ignore
      (Js.Unsafe.meth_call
         (Js.Unsafe.inject Dom_html.window)
         "addEventListener"
         [| Js.Unsafe.inject (Js.string "resize"); resize_callback_any |]);
    mutation := observe "MutationObserver";
    Option.iter !mutation ~f:(fun observer ->
        let options = Js.Unsafe.obj [||] in
        Js.Unsafe.set options "childList" true;
        Js.Unsafe.set options "subtree" true;
        Js.Unsafe.set options "characterData" true;
        ignore (Js.Unsafe.meth_call observer "observe" [| value; options |]));
    resize := observe "ResizeObserver";
    Option.iter !resize ~f:(fun observer ->
        ignore (Js.Unsafe.meth_call observer "observe" [| value |]);
        let stream =
          Js.Unsafe.meth_call value "querySelector"
            [| Js.Unsafe.inject (Js.string ".timeline-stream") |]
        in
        if present stream then
          ignore (Js.Unsafe.meth_call observer "observe" [| stream |]));
    schedule ())

let start_now () =
  cleanup_now ();
  following := true;
  frame := Some (request_frame install)

let action_effect action =
  Effect.of_deferred_thunk (fun () ->
      action ();
      Async_kernel.Deferred.return ())

let start () = action_effect start_now

let reset () =
  action_effect (fun () ->
      match !timeline with
      | None -> start_now ()
      | Some _ ->
          following := true;
          schedule ())

let jump_to_latest () =
  action_effect (fun () ->
      following := true;
      schedule ())

let cleanup () = action_effect cleanup_now
