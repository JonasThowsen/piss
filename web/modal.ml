open! Core
open! Bonsai_web.Cont
open Js_of_ocaml

type kind = Dialog | Alertdialog

type active = {
  keydown : Js.Unsafe.any;
  previous_focus : Js.Unsafe.any;
  previous_overflow : string;
}

let active : active option ref = ref None
let can_dismiss = ref true
let dispatch action = Vdom.Effect.Expert.handle_non_dom_event_exn action

let present value =
  Js.to_bool
    (Js.Unsafe.coerce
       (Js.Unsafe.fun_call
          (Js.Unsafe.get (Js.Unsafe.inject Dom_html.window) "Boolean")
          [| value |]))

let same left right =
  Js.to_bool
    (Js.Unsafe.coerce
       (Js.Unsafe.fun_call
          (Js.Unsafe.js_expr "(function(a,b){return a===b;})")
          [| left; right |]))

let by_id id =
  Js.Unsafe.meth_call
    (Js.Unsafe.inject Dom_html.document)
    "getElementById"
    [| Js.Unsafe.inject (Js.string id) |]

let set_background excluded =
  let background = by_id "control-room" in
  if present background then
    if excluded then (
      Js.Unsafe.set background "inert" (Js.bool true);
      ignore
        (Js.Unsafe.meth_call background "setAttribute"
           [|
             Js.Unsafe.inject (Js.string "aria-hidden");
             Js.Unsafe.inject (Js.string "true");
           |]))
    else (
      Js.Unsafe.set background "inert" (Js.bool false);
      ignore
        (Js.Unsafe.meth_call background "removeAttribute"
           [| Js.Unsafe.inject (Js.string "aria-hidden") |]))

let schedule callback =
  let callback = Js.wrap_callback callback in
  ignore
    (Js.Unsafe.meth_call
       (Js.Unsafe.inject Dom_html.window)
       "setTimeout"
       [| Js.Unsafe.inject callback; Js.Unsafe.inject 0 |])

let mobile () =
  try
    let query =
      Js.Unsafe.meth_call
        (Js.Unsafe.inject Dom_html.window)
        "matchMedia"
        [| Js.Unsafe.inject (Js.string "(max-width: 760px)") |]
    in
    let matches : bool Js.t = Js.Unsafe.get query "matches" in
    Js.to_bool matches
  with _ -> false

let deactivate_now () =
  Option.iter !active ~f:(fun state ->
      ignore
        (Js.Unsafe.meth_call
           (Js.Unsafe.inject Dom_html.document)
           "removeEventListener"
           [| Js.Unsafe.inject (Js.string "keydown"); state.keydown |]);
      let style =
        Js.Unsafe.get
          (Js.Unsafe.get (Js.Unsafe.inject Dom_html.document) "body")
          "style"
      in
      Js.Unsafe.set style "overflow" (Js.string state.previous_overflow);
      set_background false;
      schedule (fun () ->
          let previous_focus =
            if mobile () && present state.previous_focus then
              let rail =
                Js.Unsafe.meth_call state.previous_focus "closest"
                  [| Js.Unsafe.inject (Js.string ".runtime-rail") |]
              in
              if present rail then by_id "mobile-menu-button"
              else state.previous_focus
            else state.previous_focus
          in
          if present previous_focus then
            try
              let connected : bool Js.t =
                Js.Unsafe.get previous_focus "isConnected"
              in
              let disabled : bool Js.t =
                Js.Unsafe.get previous_focus "disabled"
              in
              if Js.to_bool connected && not (Js.to_bool disabled) then
                ignore (Js.Unsafe.meth_call previous_focus "focus" [||])
            with _ -> ());
      active := None)

let focusables surface =
  Js.Unsafe.meth_call surface "querySelectorAll"
    [|
      Js.Unsafe.inject
        (Js.string
           "button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex='-1'])");
    |]

let activate ~surface_id ~initial_focus ~dismissible ~on_close =
  Effect.of_deferred_thunk (fun () ->
      deactivate_now ();
      let document = Js.Unsafe.inject Dom_html.document in
      let previous_focus = Js.Unsafe.get document "activeElement" in
      let style = Js.Unsafe.get (Js.Unsafe.get document "body") "style" in
      let previous_overflow =
        Js.to_string (Js.Unsafe.coerce (Js.Unsafe.get style "overflow"))
      in
      Js.Unsafe.set style "overflow" (Js.string "hidden");
      set_background true;
      let keydown =
        Js.wrap_callback (fun event ->
            let event = Js.Unsafe.inject event in
            let key =
              Js.to_string (Js.Unsafe.coerce (Js.Unsafe.get event "key"))
            in
            if String.equal key "Escape" && !can_dismiss then (
              ignore (Js.Unsafe.meth_call event "preventDefault" [||]);
              dispatch (on_close ()))
            else if String.equal key "Tab" then
              let surface = by_id surface_id in
              if present surface then
                let nodes = focusables surface in
                let length : int = Js.Unsafe.get nodes "length" in
                if length = 0 then (
                  ignore (Js.Unsafe.meth_call event "preventDefault" [||]);
                  ignore (Js.Unsafe.meth_call surface "focus" [||]))
                else
                  let first =
                    Js.Unsafe.meth_call nodes "item" [| Js.Unsafe.inject 0 |]
                  and last =
                    Js.Unsafe.meth_call nodes "item"
                      [| Js.Unsafe.inject (length - 1) |]
                  and focused = Js.Unsafe.get document "activeElement" in
                  let shift : bool Js.t = Js.Unsafe.get event "shiftKey" in
                  if
                    (Js.to_bool shift && same focused first)
                    || ((not (Js.to_bool shift)) && same focused last)
                  then (
                    ignore (Js.Unsafe.meth_call event "preventDefault" [||]);
                    ignore
                      (Js.Unsafe.meth_call
                         (if Js.to_bool shift then last else first)
                         "focus" [||])))
      in
      let keydown = Js.Unsafe.inject keydown in
      ignore
        (Js.Unsafe.meth_call document "addEventListener"
           [| Js.Unsafe.inject (Js.string "keydown"); keydown |]);
      active := Some { keydown; previous_focus; previous_overflow };
      can_dismiss := dismissible;
      schedule (fun () ->
          let target = by_id initial_focus in
          let target = if present target then target else by_id surface_id in
          if present target then
            ignore (Js.Unsafe.meth_call target "focus" [||]));
      Async_kernel.Deferred.return ())

let deactivate () =
  Effect.of_deferred_thunk (fun () ->
      deactivate_now ();
      Async_kernel.Deferred.return ())

let set_dismissible value =
  Effect.of_deferred_thunk (fun () ->
      can_dismiss := value;
      Async_kernel.Deferred.return ())

let cleanup = deactivate

let surface ~kind ~surface_id ~labelled_by ?described_by ~class_name
    ~dismissible ~on_close children =
  let role =
    match kind with Dialog -> "dialog" | Alertdialog -> "alertdialog"
  in
  let description =
    Option.value_map described_by ~default:[] ~f:(fun id ->
        [ Vdom.Attr.create "aria-describedby" id ])
  in
  Vdom.Node.div
    ~attrs:
      [
        Vdom.Attr.class_ "modal-surface-backdrop";
        Vdom.Attr.on_mousedown (fun event ->
            let event = Js.Unsafe.inject event in
            if
              dismissible
              && same
                   (Js.Unsafe.get event "target")
                   (Js.Unsafe.get event "currentTarget")
            then on_close ()
            else Effect.Ignore);
      ]
    [
      Vdom.Node.div
        ~attrs:
          ([
             Vdom.Attr.id surface_id;
             Vdom.Attr.class_ ("modal-surface-popup " ^ class_name);
             Vdom.Attr.create "role" role;
             Vdom.Attr.create "aria-modal" "true";
             Vdom.Attr.create "aria-labelledby" labelled_by;
             Vdom.Attr.create "tabindex" "-1";
           ]
          @ description)
        children;
    ]
