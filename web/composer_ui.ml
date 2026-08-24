open! Core
open! Bonsai_web.Cont
open Js_of_ocaml

let class_ name = Vdom.Attr.class_ name
let text = Vdom.Node.text
let input_id = "prompt-input"
let dispatch action = Vdom.Effect.Expert.handle_non_dom_event_exn action

let present value =
  Js.to_bool
    (Js.Unsafe.coerce
       (Js.Unsafe.fun_call
          (Js.Unsafe.get (Js.Unsafe.inject Dom_html.window) "Boolean")
          [| value |]))

let selection_from target fallback =
  try
    let start : int = Js.Unsafe.get target "selectionStart" in
    let stop : int = Js.Unsafe.get target "selectionEnd" in
    (start, stop)
  with _ -> (fallback, fallback)

let event_selection event fallback =
  selection_from
    (Js.Unsafe.get (Js.Unsafe.inject event) "currentTarget")
    fallback

let field_snapshot fallback =
  let field =
    Js.Unsafe.meth_call
      (Js.Unsafe.inject Dom_html.document)
      "getElementById"
      [| Js.Unsafe.inject (Js.string input_id) |]
  in
  if present field then
    let value =
      try Js.to_string (Js.Unsafe.coerce (Js.Unsafe.get field "value"))
      with _ -> fallback
    in
    let start, stop = selection_from field (String.length value) in
    (value, start, stop)
  else (fallback, String.length fallback, String.length fallback)

let apply_to_field (insertion : Mention_picker.insertion) =
  let field =
    Js.Unsafe.meth_call
      (Js.Unsafe.inject Dom_html.document)
      "getElementById"
      [| Js.Unsafe.inject (Js.string input_id) |]
  in
  if present field then (
    Js.Unsafe.set field "value" (Js.string insertion.text);
    ignore (Js.Unsafe.meth_call field "focus" [||]);
    ignore
      (Js.Unsafe.meth_call field "setSelectionRange"
         [|
           Js.Unsafe.inject insertion.cursor; Js.Unsafe.inject insertion.cursor;
         |]))

let focus_selection ~start ~stop =
  let focus () =
    let field =
      Js.Unsafe.meth_call
        (Js.Unsafe.inject Dom_html.document)
        "getElementById"
        [| Js.Unsafe.inject (Js.string input_id) |]
    in
    if present field then (
      let options = Js.Unsafe.obj [||] in
      Js.Unsafe.set options "preventScroll" true;
      (try ignore (Js.Unsafe.meth_call field "focus" [| options |])
       with _ -> ignore (Js.Unsafe.meth_call field "focus" [||]));
      ignore
        (Js.Unsafe.meth_call field "setSelectionRange"
           [| Js.Unsafe.inject start; Js.Unsafe.inject stop |]))
  in
  let request_frame callback =
    ignore
      (Js.Unsafe.meth_call
         (Js.Unsafe.inject Dom_html.window)
         "requestAnimationFrame"
         [| Js.Unsafe.inject callback |])
  in
  focus ();
  let settle = Js.wrap_callback focus in
  let after_render =
    Js.wrap_callback (fun () ->
        focus ();
        request_frame settle)
  in
  request_frame after_render

let focus_at cursor = focus_selection ~start:cursor ~stop:cursor

let key event =
  try
    Js.to_string
      (Js.Unsafe.coerce (Js.Unsafe.get (Js.Unsafe.inject event) "key"))
  with _ -> ""

let event_bool event name =
  try
    Js.to_bool (Js.Unsafe.coerce (Js.Unsafe.get (Js.Unsafe.inject event) name))
  with _ -> false

let is_mobile () =
  try
    Js.to_bool
      (Js.Unsafe.coerce
         (Js.Unsafe.get
            (Js.Unsafe.meth_call
               (Js.Unsafe.inject Dom_html.window)
               "matchMedia"
               [| Js.Unsafe.inject (Js.string "(max-width: 760px)") |])
            "matches"))
  with _ -> false

let prevent action =
  Effect.Many
    [ Vdom.Effect.Prevent_default; Vdom.Effect.Stop_propagation; action ]

let command_picker_view active commands ~selected ~on_hover ~on_choose =
  match active with
  | None -> Vdom.Node.none
  | Some active ->
      let contents =
        match commands with
        | [] ->
            [
              Vdom.Node.p
                ~attrs:[ class_ "command-picker-state" ]
                [ text "No matching commands. Send to run it directly." ];
            ]
        | commands ->
            List.mapi commands ~f:(fun index command ->
                Vdom.Node.button ~key:command.Runtime_domain.name
                  ~attrs:
                    [
                      Vdom.Attr.id (Printf.sprintf "slash-command-%d" index);
                      Vdom.Attr.create "type" "button";
                      Vdom.Attr.create "role" "option";
                      Vdom.Attr.create "aria-label"
                        ("/" ^ command.name ^ ": " ^ command.description);
                      Vdom.Attr.create "aria-selected"
                        (Bool.to_string (index = selected));
                      (if index = selected then class_ "active" else class_ "");
                      Vdom.Attr.on_mouseenter (fun _ -> on_hover index);
                      Vdom.Attr.on_mousedown (fun _ ->
                          Vdom.Effect.Prevent_default);
                      Vdom.Attr.on_click (fun _ -> on_choose command);
                    ]
                  [
                    Vdom.Node.create "i" [ text "/" ];
                    Vdom.Node.span
                      [
                        Vdom.Node.create "b" [ text ("/" ^ command.name) ];
                        Vdom.Node.create "small"
                          [
                            text
                              (Option.value command.input_hint
                                 ~default:command.description);
                          ];
                      ];
                  ])
      in
      Vdom.Node.div
        ~attrs:
          [
            class_ "command-picker-menu";
            Vdom.Attr.id "slash-command-options";
            Vdom.Attr.create "role" "listbox";
            Vdom.Attr.create "aria-label" "Agent commands and skills";
          ]
        (Vdom.Node.header
           [
             Vdom.Node.span [ text "Commands & skills" ];
             Vdom.Node.create "small"
               [ text ("/" ^ active.Command_picker.query) ];
           ]
        :: contents)

let picker_view picker ~on_hover ~on_choose =
  match picker with
  | Mention_picker.Closed -> Vdom.Node.none
  | Open { active; availability; selected; _ } ->
      let contents =
        match availability with
        | Loading ->
            [
              Vdom.Node.p
                ~attrs:[ class_ "file-mention-state" ]
                [ text "Searching workspace files..." ];
            ]
        | Failed message ->
            [
              Vdom.Node.p
                ~attrs:[ class_ "file-mention-state error" ]
                [ text message ];
            ]
        | Ready [] ->
            [
              Vdom.Node.p
                ~attrs:[ class_ "file-mention-state" ]
                [ text "No workspace files match." ];
            ]
        | Ready resources ->
            List.mapi resources ~f:(fun index resource ->
                Vdom.Node.button ~key:resource.path
                  ~attrs:
                    [
                      Vdom.Attr.id (Printf.sprintf "file-mention-%d" index);
                      Vdom.Attr.create "type" "button";
                      Vdom.Attr.create "role" "option";
                      Vdom.Attr.create "aria-label"
                        (resource.name ^ " " ^ resource.path);
                      Vdom.Attr.create "aria-selected"
                        (Bool.to_string (index = selected));
                      (if index = selected then class_ "active" else class_ "");
                      Vdom.Attr.on_mouseenter (fun _ -> on_hover index);
                      Vdom.Attr.on_mousedown (fun _ ->
                          Vdom.Effect.Prevent_default);
                      Vdom.Attr.on_click (fun _ -> on_choose resource);
                    ]
                  [
                    Vdom.Node.create "i" [ text "@" ];
                    Vdom.Node.span
                      [
                        Vdom.Node.create "b" [ text resource.name ];
                        Vdom.Node.create "small" [ text resource.path ];
                      ];
                  ])
      in
      Vdom.Node.div
        ~attrs:
          [
            class_ "file-mention-menu";
            Vdom.Attr.id "file-mention-options";
            Vdom.Attr.create "role" "listbox";
            Vdom.Attr.create "aria-label" "Workspace files";
          ]
        (Vdom.Node.header
           [
             Vdom.Node.span [ text "Workspace files" ];
             Vdom.Node.create "small" [ text active.query ];
           ]
        :: contents)
