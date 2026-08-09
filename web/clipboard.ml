open! Core
open! Bonsai_web.Cont
open Js_of_ocaml

type status = Copied | Failed

let generation = ref 0
let reset_timer : Js.Unsafe.any option ref = ref None
let dispatch action = Vdom.Effect.Expert.handle_non_dom_event_exn action

let present value =
  Js.to_bool
    (Js.Unsafe.coerce
       (Js.Unsafe.fun_call
          (Js.Unsafe.get (Js.Unsafe.inject Dom_html.window) "Boolean")
          [| value |]))

let integer value =
  Js.to_bool
    (Js.Unsafe.coerce
       (Js.Unsafe.meth_call
          (Js.Unsafe.get (Js.Unsafe.inject Dom_html.window) "Number")
          "isInteger" [| value |]))

let clear_timer () =
  Option.iter !reset_timer ~f:(fun timer ->
      ignore
        (Js.Unsafe.meth_call
           (Js.Unsafe.inject Dom_html.window)
           "clearTimeout" [| timer |]));
  reset_timer := None

let fallback text complete =
  let document = Js.Unsafe.inject Dom_html.document in
  let active = Js.Unsafe.get document "activeElement" in
  let selection =
    if present active then
      let start_value = Js.Unsafe.get active "selectionStart" in
      let end_value = Js.Unsafe.get active "selectionEnd" in
      if integer start_value && integer end_value then
        let start : int = Js.Unsafe.get active "selectionStart" in
        let end_ : int = Js.Unsafe.get active "selectionEnd" in
        Some (start, end_)
      else None
    else None
  in
  let field =
    Js.Unsafe.meth_call document "createElement"
      [| Js.Unsafe.inject (Js.string "textarea") |]
  in
  let body = Js.Unsafe.get document "body" in
  let remove () =
    try
      let parent = Js.Unsafe.get field "parentNode" in
      if present parent then
        ignore (Js.Unsafe.meth_call parent "removeChild" [| field |])
    with _ -> ()
  in
  let restore () =
    if present active then (
      let options = Js.Unsafe.obj [||] in
      Js.Unsafe.set options "preventScroll" true;
      (try ignore (Js.Unsafe.meth_call active "focus" [| options |])
       with _ -> (
         try ignore (Js.Unsafe.meth_call active "focus" [||]) with _ -> ()));
      Option.iter selection ~f:(fun (start, end_) ->
          try
            ignore
              (Js.Unsafe.meth_call active "setSelectionRange"
                 [| Js.Unsafe.inject start; Js.Unsafe.inject end_ |])
          with _ -> ()))
  in
  let finish success =
    remove ();
    restore ();
    complete success
  in
  try
    Js.Unsafe.set field "value" (Js.string text);
    ignore
      (Js.Unsafe.meth_call field "setAttribute"
         [|
           Js.Unsafe.inject (Js.string "readonly");
           Js.Unsafe.inject (Js.string "");
         |]);
    let style = Js.Unsafe.get field "style" in
    Js.Unsafe.set style "position" (Js.string "fixed");
    Js.Unsafe.set style "opacity" (Js.string "0");
    ignore (Js.Unsafe.meth_call body "appendChild" [| field |]);
    ignore (Js.Unsafe.meth_call field "select" [||]);
    let copied =
      Js.Unsafe.meth_call document "execCommand"
        [| Js.Unsafe.inject (Js.string "copy") |]
    in
    finish (Js.to_bool (Js.Unsafe.coerce copied))
  with _ -> finish false

let write text complete =
  try
    let navigator =
      Js.Unsafe.get (Js.Unsafe.inject Dom_html.window) "navigator"
    in
    let clipboard = Js.Unsafe.get navigator "clipboard" in
    let write_text = Js.Unsafe.get clipboard "writeText" in
    if present clipboard && present write_text then
      let promise =
        Js.Unsafe.meth_call clipboard "writeText"
          [| Js.Unsafe.inject (Js.string text) |]
      in
      let copied = Js.wrap_callback (fun _ -> complete true) in
      let failed = Js.wrap_callback (fun _ -> fallback text complete) in
      ignore
        (Js.Unsafe.meth_call promise "then"
           [| Js.Unsafe.inject copied; Js.Unsafe.inject failed |])
    else fallback text complete
  with _ -> fallback text complete

let copy ~key ~text ~on_change =
  Effect.of_deferred_thunk (fun () ->
      clear_timer ();
      incr generation;
      let request = !generation in
      write text (fun success ->
          if request = !generation then (
            let status = if success then Copied else Failed in
            dispatch (on_change (Some (key, status)));
            let reset =
              Js.wrap_callback (fun () ->
                  if request = !generation then (
                    reset_timer := None;
                    dispatch (on_change None)))
            in
            let timer =
              Js.Unsafe.meth_call
                (Js.Unsafe.inject Dom_html.window)
                "setTimeout"
                [| Js.Unsafe.inject reset; Js.Unsafe.inject 1800 |]
            in
            reset_timer := Some timer));
      Async_kernel.Deferred.return ())

let cleanup () =
  Effect.of_deferred_thunk (fun () ->
      incr generation;
      clear_timer ();
      Async_kernel.Deferred.return ())
