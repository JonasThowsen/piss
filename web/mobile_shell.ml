open! Core
open! Bonsai_web.Cont
open Js_of_ocaml

type listener = {
  target : Js.Unsafe.any;
  name : string;
  callback : Js.Unsafe.any;
}

let listeners : listener list ref = ref []
let dispatch action = Vdom.Effect.Expert.handle_non_dom_event_exn action

let present value =
  Js.to_bool
    (Js.Unsafe.coerce
       (Js.Unsafe.fun_call
          (Js.Unsafe.get (Js.Unsafe.inject Dom_html.window) "Boolean")
          [| value |]))

let sync_height () =
  let window = Js.Unsafe.inject Dom_html.window in
  let viewport = Js.Unsafe.get window "visualViewport" in
  let height : float =
    if present viewport then Js.Unsafe.get viewport "height"
    else Js.Unsafe.get window "innerHeight"
  in
  let root =
    Js.Unsafe.get (Js.Unsafe.inject Dom_html.document) "documentElement"
  in
  let style = Js.Unsafe.get root "style" in
  ignore
    (Js.Unsafe.meth_call style "setProperty"
       [|
         Js.Unsafe.inject (Js.string "--app-height");
         Js.Unsafe.inject (Js.string (Printf.sprintf "%.0fpx" height));
       |])

let listen target name callback =
  let callback = Js.Unsafe.inject callback in
  ignore
    (Js.Unsafe.meth_call target "addEventListener"
       [| Js.Unsafe.inject (Js.string name); callback |]);
  listeners := { target; name; callback } :: !listeners

let cleanup_now () =
  List.iter !listeners ~f:(fun listener ->
      ignore
        (Js.Unsafe.meth_call listener.target "removeEventListener"
           [| Js.Unsafe.inject (Js.string listener.name); listener.callback |]));
  listeners := []

let start ~on_escape =
  Effect.of_deferred_thunk (fun () ->
      cleanup_now ();
      sync_height ();
      let window = Js.Unsafe.inject Dom_html.window in
      let document = Js.Unsafe.inject Dom_html.document in
      let viewport = Js.Unsafe.get window "visualViewport" in
      let resize = Js.wrap_callback (fun _ -> sync_height ()) in
      listen window "resize" resize;
      listen window "pageshow" resize;
      if present viewport then listen viewport "resize" resize;
      let visible =
        Js.wrap_callback (fun _ ->
            let state : Js.js_string Js.t =
              Js.Unsafe.get document "visibilityState"
            in
            if String.equal (Js.to_string state) "visible" then sync_height ())
      in
      listen document "visibilitychange" visible;
      let escape =
        Js.wrap_callback (fun event ->
            let key : Js.js_string Js.t = Js.Unsafe.get event "key" in
            if String.equal (Js.to_string key) "Escape" then
              dispatch (on_escape ()))
      in
      listen document "keydown" escape;
      Async_kernel.Deferred.return ())

let cleanup () =
  Effect.of_deferred_thunk (fun () ->
      cleanup_now ();
      Async_kernel.Deferred.return ())

let focus id =
  Effect.of_deferred_thunk (fun () ->
      let callback =
        Js.wrap_callback (fun () ->
            let element =
              Js.Unsafe.meth_call
                (Js.Unsafe.inject Dom_html.document)
                "getElementById"
                [| Js.Unsafe.inject (Js.string id) |]
            in
            if present element then
              ignore (Js.Unsafe.meth_call element "focus" [||]))
      in
      ignore
        (Js.Unsafe.meth_call
           (Js.Unsafe.inject Dom_html.window)
           "requestAnimationFrame"
           [| Js.Unsafe.inject callback |]);
      Async_kernel.Deferred.return ())

let focus_navigation () = focus "workspace-navigation"
let focus_menu_button () = focus "mobile-menu-button"

let menu_icon () =
  Vdom.Node.create_svg "svg"
    ~attrs:
      [
        Vdom.Attr.create "viewBox" "0 0 24 24";
        Vdom.Attr.create "fill" "none";
        Vdom.Attr.create "stroke" "currentColor";
        Vdom.Attr.create "stroke-width" "1.8";
        Vdom.Attr.create "stroke-linecap" "round";
        Vdom.Attr.create "aria-hidden" "true";
      ]
    [
      Vdom.Node.create_svg "path"
        ~attrs:[ Vdom.Attr.create "d" "M4 7h16M4 12h16M4 17h16" ]
        [];
    ]

let menu_button ~open_ ~on_toggle =
  Vdom.Node.button
    ~attrs:
      [
        Vdom.Attr.id "mobile-menu-button";
        Vdom.Attr.class_ "mobile-menu";
        Vdom.Attr.create "type" "button";
        Vdom.Attr.create "aria-label"
          (if open_ then "Close workspaces and sessions"
           else "Open workspaces and sessions");
        Vdom.Attr.create "aria-controls" "workspace-navigation";
        Vdom.Attr.create "aria-expanded" (Bool.to_string open_);
        Vdom.Attr.on_click (fun _ -> on_toggle ());
      ]
    [ menu_icon () ]

let scrim ~open_ ~on_close =
  Vdom.Node.button
    ~attrs:
      [
        Vdom.Attr.class_ ("sidebar-scrim" ^ if open_ then " visible" else "");
        Vdom.Attr.create "type" "button";
        Vdom.Attr.create "aria-label" "Close workspaces and sessions";
        Vdom.Attr.create "tabindex" "-1";
        Vdom.Attr.on_click (fun _ -> on_close ());
      ]
    []
