open! Core
open! Bonsai_web.Cont
open Bonsai.Let_syntax
open Js_of_ocaml

type control_state =
  | Available
  | Requesting
  | Enabled
  | Denied
  | Unsupported
  | Failed

let storage_key = "piss:desktop-notifications"

let observed_sessions : (string, Notification_policy.state) Hashtbl.t =
  Hashtbl.create (module String)

let initialized = ref false

let present value =
  Js.to_bool
    (Js.Unsafe.coerce
       (Js.Unsafe.fun_call
          (Js.Unsafe.get (Js.Unsafe.inject Dom_html.window) "Boolean")
          [| value |]))

let window () = Js.Unsafe.inject Dom_html.window
let navigator () = Js.Unsafe.get (window ()) "navigator"
let storage () = Js.Unsafe.get (window ()) "localStorage"

let supported () =
  try
    present (Js.Unsafe.get (window ()) "Notification")
    && present (Js.Unsafe.get (navigator ()) "serviceWorker")
  with _ -> false

let permission () =
  try
    let notification = Js.Unsafe.get (window ()) "Notification" in
    Js.Unsafe.get notification "permission" |> Js.Unsafe.coerce |> Js.to_string
  with _ -> "unsupported"

let preference () =
  try
    let value =
      Js.Unsafe.meth_call (storage ()) "getItem"
        [| Js.Unsafe.inject (Js.string storage_key) |]
    in
    present value
    && String.equal (Js.Unsafe.coerce value |> Js.to_string) "true"
  with _ -> false

let set_preference enabled =
  try
    if enabled then
      ignore
        (Js.Unsafe.meth_call (storage ()) "setItem"
           [|
             Js.Unsafe.inject (Js.string storage_key);
             Js.Unsafe.inject (Js.string "true");
           |])
    else
      ignore
        (Js.Unsafe.meth_call (storage ()) "removeItem"
           [| Js.Unsafe.inject (Js.string storage_key) |])
  with _ -> ()

let enabled () =
  supported () && preference () && String.equal (permission ()) "granted"

let control_state () =
  if not (supported ()) then Unsupported
  else
    match permission () with
    | "denied" -> Denied
    | "granted" when preference () -> Enabled
    | "granted" | "default" -> Available
    | _ -> Unsupported

let backgrounded () =
  try
    let visibility : Js.js_string Js.t =
      Js.Unsafe.get (Js.Unsafe.inject Dom_html.document) "visibilityState"
    in
    let focused =
      Js.Unsafe.meth_call (Js.Unsafe.inject Dom_html.document) "hasFocus" [||]
      |> Js.Unsafe.coerce |> Js.to_bool
    in
    (not (String.equal (Js.to_string visibility) "visible")) || not focused
  with _ -> true

let request_permission () =
  let result = Async_kernel.Ivar.create () in
  let finish value = Async_kernel.Ivar.fill_if_empty result value in
  (try
     let notification = Js.Unsafe.get (window ()) "Notification" in
     let promise = Js.Unsafe.meth_call notification "requestPermission" [||] in
     let granted =
       Js.wrap_callback (fun value ->
           let permission = Js.Unsafe.coerce value |> Js.to_string in
           if String.equal permission "granted" then (
             set_preference true;
             finish Enabled)
           else if String.equal permission "denied" then finish Denied
           else finish Available)
     in
     let failed = Js.wrap_callback (fun _ -> finish Failed) in
     ignore
       (Js.Unsafe.meth_call promise "then"
          [| Js.Unsafe.inject granted; Js.Unsafe.inject failed |])
   with _ -> finish Failed);
  Async_kernel.Ivar.read result

let notification_message ~title ~body ~session_id =
  let data =
    Js.Unsafe.obj
      [|
        ("url", Js.Unsafe.inject (Js.string ("/?session=" ^ session_id)));
        ("sessionId", Js.Unsafe.inject (Js.string session_id));
      |]
  in
  Js.Unsafe.obj
    [|
      ("type", Js.Unsafe.inject (Js.string "piss:show-notification"));
      ("title", Js.Unsafe.inject (Js.string title));
      ("body", Js.Unsafe.inject (Js.string body));
      ("tag", Js.Unsafe.inject (Js.string ("piss-session-" ^ session_id)));
      ("data", Js.Unsafe.inject data);
    |]

let show ~title ~body ~session_id =
  if enabled () && backgrounded () then
    try
      let service_worker = Js.Unsafe.get (navigator ()) "serviceWorker" in
      let ready = Js.Unsafe.get service_worker "ready" in
      let deliver =
        Js.wrap_callback (fun registration ->
            let active = Js.Unsafe.get registration "active" in
            if present active then
              ignore
                (Js.Unsafe.meth_call active "postMessage"
                   [|
                     Js.Unsafe.inject
                       (notification_message ~title ~body ~session_id);
                   |]))
      in
      let ignore_failure = Js.wrap_callback (fun _ -> ()) in
      ignore
        (Js.Unsafe.meth_call ready "then"
           [| Js.Unsafe.inject deliver; Js.Unsafe.inject ignore_failure |])
    with _ -> ()

let notify_transition (session : Control_plane.Session.t) previous current =
  match Notification_policy.decide ~previous ~current with
  | None -> ()
  | Some Requires_action ->
      show ~title:"Piss needs your attention"
        ~body:(session.title ^ " is waiting for a decision.")
        ~session_id:session.id
  | Some Failed ->
      show ~title:"Piss session failed"
        ~body:(session.title ^ " stopped with an error.")
        ~session_id:session.id
  | Some Delegated_work_finished ->
      show ~title:"Delegated work finished"
        ~body:(session.title ^ " is idle again.")
        ~session_id:session.id
  | Some (Turn_finished { delegated_work_remains }) ->
      let body =
        if delegated_work_remains then
          session.title ^ " finished its turn and is waiting on delegated work."
        else session.title ^ " finished its turn."
      in
      show ~title:"Piss agent finished" ~body ~session_id:session.id

let observe_sessions sessions =
  List.iter sessions ~f:(fun (session : Control_plane.Session.t) ->
      let current : Notification_policy.state =
        { status = session.status; last_finished_at = session.last_finished_at }
      in
      Option.iter (Hashtbl.find observed_sessions session.id)
        ~f:(fun previous ->
          if !initialized then notify_transition session previous current);
      Hashtbl.set observed_sessions ~key:session.id ~data:current);
  let active_ids =
    String.Set.of_list
      (List.map sessions ~f:(fun (session : Control_plane.Session.t) ->
           session.id))
  in
  Hashtbl.filter_keys_inplace observed_sessions ~f:(Set.mem active_ids);
  initialized := true

let requested_session () =
  try
    let href : Js.js_string Js.t = Js.Unsafe.get (window ()) "location.href" in
    Uri.of_string (Js.to_string href) |> fun uri ->
    Uri.get_query_param uri "session"
    |> Option.filter ~f:(fun value ->
        (not (String.is_empty value)) && String.length value <= 512)
  with _ -> None

let clear_requested_session () =
  try
    let location = Js.Unsafe.get (window ()) "location" in
    let pathname : Js.js_string Js.t = Js.Unsafe.get location "pathname" in
    let url =
      Js.Unsafe.new_obj
        (Js.Unsafe.get (window ()) "URL")
        [| Js.Unsafe.get location "href" |]
    in
    let parameters = Js.Unsafe.get url "searchParams" in
    ignore
      (Js.Unsafe.meth_call parameters "delete"
         [| Js.Unsafe.inject (Js.string "session") |]);
    let search : Js.js_string Js.t = Js.Unsafe.get url "search" in
    let hash : Js.js_string Js.t = Js.Unsafe.get url "hash" in
    let target =
      Js.to_string pathname ^ Js.to_string search ^ Js.to_string hash
    in
    let history = Js.Unsafe.get (window ()) "history" in
    ignore
      (Js.Unsafe.meth_call history "replaceState"
         [|
           Js.Unsafe.inject Js.null;
           Js.Unsafe.inject (Js.string "");
           Js.Unsafe.inject (Js.string target);
         |])
  with _ -> ()

let bell_icon ~enabled =
  let attrs =
    [
      Vdom.Attr.create "viewBox" "0 0 24 24";
      Vdom.Attr.create "aria-hidden" "true";
      Vdom.Attr.create "fill" (if enabled then "currentColor" else "none");
      Vdom.Attr.create "stroke" "currentColor";
      Vdom.Attr.create "stroke-width" "1.8";
      Vdom.Attr.create "stroke-linecap" "round";
      Vdom.Attr.create "stroke-linejoin" "round";
    ]
  in
  Vdom.Node.create_svg "svg" ~attrs
    [
      Vdom.Node.create_svg "path"
        ~attrs:
          [
            Vdom.Attr.create "d"
              "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9";
          ]
        [];
      Vdom.Node.create_svg "path" ~attrs:[ Vdom.Attr.create "d" "M10 21h4" ] [];
    ]

let component graph =
  let state, set_state = Bonsai.state (control_state ()) graph in
  let%arr state = state and set_state = set_state in
  let enabled = phys_equal state Enabled in
  let label, title, disabled =
    match state with
    | Enabled ->
        ("Disable desktop notifications", "Desktop notifications enabled", false)
    | Available ->
        ("Enable desktop notifications", "Enable desktop notifications", false)
    | Requesting ->
        ( "Enabling desktop notifications",
          "Requesting notification permission",
          true )
    | Denied ->
        ( "Desktop notifications blocked",
          "Allow notifications for this site in Chromium settings",
          true )
    | Unsupported ->
        ( "Desktop notifications unavailable",
          "This browser does not support service-worker notifications",
          true )
    | Failed ->
        ( "Retry desktop notifications",
          "Notification permission failed; click to retry",
          false )
  in
  let activate =
    match state with
    | Enabled ->
        Effect.Many
          [ Effect.of_sync_fun set_preference false; set_state Available ]
    | Available | Failed ->
        Effect.bind (set_state Requesting) ~f:(fun () ->
            Effect.bind
              (Effect.of_deferred_thunk request_permission)
              ~f:set_state)
    | Requesting | Denied | Unsupported -> Effect.Ignore
  in
  Vdom.Node.button
    ~attrs:
      ([
         Vdom.Attr.class_
           ("notification-control"
           ^ if enabled then " notification-control-enabled" else "");
         Vdom.Attr.create "type" "button";
         Vdom.Attr.create "aria-label" label;
         Vdom.Attr.create "title" title;
         Vdom.Attr.on_click (fun _ -> activate);
       ]
      @ if disabled then [ Vdom.Attr.disabled ] else [])
    [ bell_icon ~enabled ]

(* TODO(tracer): Add durable Web Push subscriptions and VAPID delivery before
   promising notifications after Chromium and the installed PWA are fully
   closed. This first slice covers the installed app while open or
   backgrounded. *)
