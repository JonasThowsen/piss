open! Core
open! Bonsai_web.Cont
open Js_of_ocaml

let timeline : Js.Unsafe.any option ref = ref None
let mutation : Js.Unsafe.any option ref = ref None
let resize : Js.Unsafe.any option ref = ref None
let frame : Js.Unsafe.any option ref = ref None
let settle_frame : Js.Unsafe.any option ref = ref None
let opening_frame : Js.Unsafe.any option ref = ref None
let listener : Js.Unsafe.any option ref = ref None
let window_listener : Js.Unsafe.any option ref = ref None
let following = ref true
let pinning = ref false
let anchoring = ref false
let anchor_generation = ref 0
let previous_top = ref 0
let previous_client_height = ref 0

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

let cancel_opening_frame () =
  Option.iter !opening_frame ~f:(fun value ->
      ignore
        (Js.Unsafe.meth_call
           (Js.Unsafe.inject Dom_html.window)
           "cancelAnimationFrame" [| value |]));
  opening_frame := None

let button () =
  let document = Js.Unsafe.inject Dom_html.document in
  let value =
    Js.Unsafe.meth_call document "querySelector"
      [|
        Js.Unsafe.inject (Js.string "[aria-label=\"Jump to latest message\"]");
      |]
  in
  if present value then Some value else None

let agent_panel_visible () =
  let panel =
    Js.Unsafe.meth_call
      (Js.Unsafe.inject Dom_html.document)
      "getElementById"
      [| Js.Unsafe.inject (Js.string "session-panel-agent") |]
  in
  if not (present panel) then true
  else
    let hidden =
      Js.Unsafe.meth_call panel "hasAttribute"
        [| Js.Unsafe.inject (Js.string "hidden") |]
    in
    not (Js.to_bool (Js.Unsafe.coerce hidden))

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
  if (not !anchoring) && Option.is_none !frame then (
    if !following then pinning := true;
    frame := Some (request_frame pin))

let on_scroll event =
  match (!timeline, agent_panel_visible ()) with
  | _, false -> ()
  | None, _ -> ()
  | Some value, true ->
      let top : int = Js.Unsafe.get value "scrollTop" in
      let client_height : int = Js.Unsafe.get value "clientHeight" in
      let resized = client_height <> !previous_client_height in
      previous_client_height := client_height;
      let explicit =
        try
          let trusted : bool Js.t = Js.Unsafe.get event "isTrusted" in
          not (Js.to_bool trusted)
        with _ -> false
      in
      if !anchoring then ()
      else if resized && not explicit then ()
      else if top < !previous_top - 1 && ((not !pinning) || explicit) then
        following := false
      else if (not !pinning) && top > !previous_top + 1 && distance value <= 80
      then following := true;
      previous_top := top;
      update_button ()

let cleanup_now () =
  Int.incr anchor_generation;
  cancel_frame ();
  cancel_settle_frame ();
  cancel_opening_frame ();
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
  timeline := None;
  anchoring := false

let observe constructor_name =
  let callback = Js.wrap_callback (fun _ -> schedule ()) in
  let constructor =
    Js.Unsafe.get (Js.Unsafe.inject Dom_html.window) constructor_name
  in
  if present constructor then
    Some (Js.Unsafe.new_obj constructor [| Js.Unsafe.inject callback |])
  else None

let rec install () =
  frame := None;
  let document = Js.Unsafe.inject Dom_html.document in
  let value =
    Js.Unsafe.meth_call document "getElementById"
      [| Js.Unsafe.inject (Js.string "timeline") |]
  in
  if not (present value) then frame := Some (request_frame install)
  else (
    timeline := Some value;
    previous_top := Js.Unsafe.get value "scrollTop";
    previous_client_height := Js.Unsafe.get value "clientHeight";
    let callback = Js.wrap_callback on_scroll in
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

let rec pin_opening frames =
  opening_frame :=
    Some
      (request_frame (fun () ->
           opening_frame := None;
           let value =
             Js.Unsafe.meth_call
               (Js.Unsafe.inject Dom_html.document)
               "getElementById"
               [| Js.Unsafe.inject (Js.string "timeline") |]
           in
           if present value then (
             timeline := Some value;
             let height : int = Js.Unsafe.get value "scrollHeight" in
             Js.Unsafe.set value "scrollTop" height;
             previous_top := Js.Unsafe.get value "scrollTop");
           if frames > 1 then pin_opening (frames - 1)
           else (
             pinning := false;
             update_button ())))

let reset () =
  action_effect (fun () ->
      Int.incr anchor_generation;
      anchoring := false;
      (match !timeline with None -> start_now () | Some _ -> ());
      following := true;
      pinning := true;
      cancel_opening_frame ();
      pin_opening 4;
      schedule ())

let jump_to_latest () =
  action_effect (fun () ->
      following := true;
      schedule ())

let resume () = action_effect (fun () -> if !following then schedule ())

type anchor = {
  key : string option;
  offset : float;
  height : float;
  top : float;
}

let number value property : float = Js.Unsafe.get value property

let bounds_top value =
  let bounds = Js.Unsafe.meth_call value "getBoundingClientRect" [||] in
  number bounds "top"

let attribute value name =
  let result =
    Js.Unsafe.meth_call value "getAttribute"
      [| Js.Unsafe.inject (Js.string name) |]
  in
  if present result then Some (Js.to_string (Js.Unsafe.coerce result)) else None

let visible_key value =
  let timeline_top = bounds_top value in
  let items =
    Js.Unsafe.meth_call value "querySelectorAll"
      [|
        Js.Unsafe.inject
          (Js.string
             ".timeline-item[data-timeline-key]:not(details[open]),details[open] \
              .timeline-item[data-timeline-key]");
      |]
  in
  let length : int = Js.Unsafe.get items "length" in
  let rec loop index =
    if index >= length then None
    else
      let item =
        Js.Unsafe.meth_call items "item" [| Js.Unsafe.inject index |]
      in
      let bounds = Js.Unsafe.meth_call item "getBoundingClientRect" [||] in
      let bottom = number bounds "bottom" in
      if Float.(bottom > timeline_top) then
        Option.map (attribute item "data-timeline-key") ~f:(fun key ->
            (key, number bounds "top" -. timeline_top))
      else loop (index + 1)
  in
  loop 0

let capture_anchor () =
  match !timeline with
  | None -> None
  | Some value ->
      let key, offset = Option.value (visible_key value) ~default:("", 0.) in
      Some
        {
          key = (if String.is_empty key then None else Some key);
          offset;
          height = number value "scrollHeight";
          top = number value "scrollTop";
        }

let find_key value key =
  let items =
    Js.Unsafe.meth_call value "querySelectorAll"
      [| Js.Unsafe.inject (Js.string ".timeline-item[data-timeline-key]") |]
  in
  let length : int = Js.Unsafe.get items "length" in
  let rec loop index =
    if index >= length then None
    else
      let item =
        Js.Unsafe.meth_call items "item" [| Js.Unsafe.inject index |]
      in
      match attribute item "data-timeline-key" with
      | Some candidate when String.equal candidate key -> Some item
      | _ -> loop (index + 1)
  in
  loop 0

let restore_anchor anchor =
  let current =
    Js.Unsafe.meth_call
      (Js.Unsafe.inject Dom_html.document)
      "getElementById"
      [| Js.Unsafe.inject (Js.string "timeline") |]
  in
  let value =
    if present current then (
      timeline := Some current;
      Some current)
    else !timeline
  in
  match value with
  | None -> ()
  | Some value ->
      let next_top =
        match Option.bind anchor.key ~f:(find_key value) with
        | Some item ->
            let timeline_top = bounds_top value in
            number value "scrollTop"
            +. (bounds_top item -. timeline_top -. anchor.offset)
        | None -> anchor.top +. (number value "scrollHeight" -. anchor.height)
      in
      Js.Unsafe.set value "scrollTop" next_top;
      previous_top := Js.Unsafe.get value "scrollTop"

let preserve_after_prepend action =
  Effect.bind
    (Effect.of_deferred_thunk (fun () ->
         let was_following = !following in
         anchoring := true;
         pinning := false;
         cancel_frame ();
         cancel_opening_frame ();
         Async_kernel.Deferred.return (capture_anchor (), was_following)))
    ~f:(fun (anchor, was_following) ->
      let generation = !anchor_generation in
      Effect.bind action ~f:(fun () ->
          Effect.of_deferred_thunk (fun () ->
              let finished = Async_kernel.Ivar.create () in
              let rec settle frames =
                ignore
                  (request_frame (fun () ->
                       if generation <> !anchor_generation then
                         Async_kernel.Ivar.fill_if_empty finished ()
                       else (
                         Option.iter anchor ~f:restore_anchor;
                         if frames > 1 then settle (frames - 1)
                         else (
                           anchoring := false;
                           following := was_following;
                           update_button ();
                           Async_kernel.Ivar.fill_if_empty finished ()))))
              in
              settle 4;
              Async_kernel.Ivar.read finished)))

let track () =
  action_effect (fun () ->
      let value =
        Js.Unsafe.meth_call
          (Js.Unsafe.inject Dom_html.document)
          "getElementById"
          [| Js.Unsafe.inject (Js.string "timeline") |]
      in
      if present value && agent_panel_visible () then (
        timeline := Some value;
        let top : int = Js.Unsafe.get value "scrollTop" in
        if top < !previous_top - 1 then following := false
        else if top > !previous_top + 1 && distance value <= 80 then
          following := true;
        previous_top := top;
        update_button ()))

let cleanup () = action_effect cleanup_now
let is_following () = !following
