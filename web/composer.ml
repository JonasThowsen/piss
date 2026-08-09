open! Core
open! Bonsai_web.Cont
open Bonsai.Let_syntax
open Js_of_ocaml

type output = {
  view : Vdom.Node.t;
  reset : unit -> unit Effect.t;
  set_notice : string -> unit Effect.t;
}

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

let focus_at cursor =
  let focus () =
    let field =
      Js.Unsafe.meth_call
        (Js.Unsafe.inject Dom_html.document)
        "getElementById"
        [| Js.Unsafe.inject (Js.string input_id) |]
    in
    if present field then (
      ignore (Js.Unsafe.meth_call field "focus" [||]);
      ignore
        (Js.Unsafe.meth_call field "setSelectionRange"
           [| Js.Unsafe.inject cursor; Js.Unsafe.inject cursor |]))
  in
  focus ();
  let callback = Js.wrap_callback focus in
  ignore
    (Js.Unsafe.meth_call
       (Js.Unsafe.inject Dom_html.window)
       "requestAnimationFrame"
       [| Js.Unsafe.inject callback |])

let key event =
  try
    Js.to_string
      (Js.Unsafe.coerce (Js.Unsafe.get (Js.Unsafe.inject event) "key"))
  with _ -> ""

let prevent action =
  Effect.Many
    [ Vdom.Effect.Prevent_default; Vdom.Effect.Stop_propagation; action ]

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

let component session stream_notice config_controls graph =
  let prompt, set_prompt = Bonsai.state "" graph in
  let resources, set_resources = Bonsai.state [] graph in
  let picker, set_picker = Bonsai.state Mention_picker.Closed graph in
  let submitting, set_submitting = Bonsai.state false graph in
  let notice, set_notice = Bonsai.state "" graph in
  let%arr session = session
  and stream_notice = stream_notice
  and config_controls = config_controls
  and prompt = prompt
  and resources = resources
  and picker = picker
  and submitting = submitting
  and notice = notice
  and set_prompt = set_prompt
  and set_resources = set_resources
  and set_picker = set_picker
  and set_submitting = set_submitting
  and set_notice = set_notice in
  let close_picker () =
    Mention_request.cancel ();
    set_picker Mention_picker.Closed
  in
  let start_search (active : Mention_picker.active) =
    match session with
    | None -> set_picker Mention_picker.Closed
    | Some (session : Control_plane.Session.t) ->
        let generation =
          Mention_request.search ~session_id:session.id ~query:active.query
            ~on_result:(fun ~generation result ->
              let loading = Mention_picker.loading active ~generation in
              let next =
                match result with
                | Ok resources ->
                    Mention_picker.resolve loading ~generation resources
                | Error Mention_request.Cancelled -> loading
                | Error (Failed message) ->
                    Mention_picker.fail loading ~generation message
              in
              match result with
              | Error Cancelled -> ()
              | _ -> dispatch (set_picker next))
        in
        set_picker (Mention_picker.loading active ~generation)
  in
  let update_prompt event value =
    let cursor, _ = event_selection event (String.length value) in
    match Mention_picker.active_at_cursor ~text:value ~cursor with
    | None -> Effect.Many [ set_prompt value; close_picker () ]
    | Some active -> Effect.Many [ set_prompt value; start_search active ]
  in
  let choose active (resource : Mention_picker.resource) =
    let live_text, cursor, _ = field_snapshot prompt in
    let active =
      Mention_picker.active_at_cursor ~text:live_text ~cursor
      |> Option.value ~default:active
    in
    match
      Mention_picker.insert_resource ~text:live_text ~active ~path:resource.path
    with
    | None -> close_picker ()
    | Some insertion ->
        Mention_request.cancel ();
        apply_to_field insertion;
        Effect.Many
          [
            set_prompt insertion.text;
            set_resources (Mention_picker.add_resource resources resource);
            set_picker Mention_picker.Closed;
          ]
  in
  let toolbar_mention () =
    let live_text, selection_start, selection_end = field_snapshot prompt in
    let insertion =
      Mention_picker.insert_trigger ~text:live_text ~selection_start
        ~selection_end
    in
    let active =
      Mention_picker.active_at_cursor ~text:insertion.text
        ~cursor:insertion.cursor
      |> Option.value_exn
    in
    apply_to_field insertion;
    Effect.Many [ set_prompt insertion.text; start_search active ]
  in
  let keydown event =
    match (key event, picker) with
    | "ArrowDown", Open { active; _ } ->
        focus_at active.stop;
        prevent (set_picker (Mention_picker.move picker 1))
    | "ArrowUp", Open { active; _ } ->
        focus_at active.stop;
        prevent (set_picker (Mention_picker.move picker (-1)))
    | "Escape", Open { active; _ } ->
        focus_at active.stop;
        prevent (close_picker ())
    | "Enter", Open { active; availability = Ready (_ :: _); _ } -> (
        match Mention_picker.selected_resource picker with
        | Some resource -> prevent (choose active resource)
        | None -> prevent Effect.Ignore)
    | "Enter", Open _ -> prevent Effect.Ignore
    | _ -> Effect.Ignore
  in
  let submit () =
    match (session, submitting) with
    | None, _ | _, true -> Effect.Ignore
    | Some (session : Control_plane.Session.t), false -> (
        let live_text, _, _ = field_snapshot prompt in
        let selected = Mention_picker.reconcile ~text:live_text resources in
        let command_resources =
          List.map selected ~f:(fun resource : Prompt_command.resource ->
              { path = resource.path })
        in
        let command_id = Command_id.create () in
        match
          Prompt_command.prompt ~command_id ~text:live_text
            ~resources:command_resources
        with
        | Error message -> set_notice message
        | Ok command ->
            Effect.bind (set_submitting true) ~f:(fun () ->
                Effect.bind
                  (Effect.of_deferred_thunk (fun () ->
                       Browser_http.post_json
                         ~query:[ ("session", session.id) ]
                         "/api/v2/commands"
                         (Prompt_command.to_yojson command)))
                  ~f:(function
                    | Error error ->
                        Effect.Many
                          [
                            set_submitting false;
                            set_notice (Error.to_string_hum error);
                          ]
                    | Ok _ ->
                        Mention_request.cancel ();
                        apply_to_field { text = ""; cursor = 0 };
                        Effect.Many
                          [
                            set_prompt "";
                            set_resources [];
                            set_picker Mention_picker.Closed;
                            set_submitting false;
                            set_notice
                              "Prompt accepted. Waiting for live events.";
                          ])))
  in
  let combined_notice =
    if String.is_empty stream_notice then notice
    else if String.is_empty notice then stream_notice
    else notice ^ " " ^ stream_notice
  in
  let active_descendant =
    match picker with
    | Open { availability = Ready (_ :: _); selected; _ } ->
        Some (Printf.sprintf "file-mention-%d" selected)
    | _ -> None
  in
  let picker_open =
    match picker with Mention_picker.Closed -> false | Open _ -> true
  in
  let on_choose resource =
    match picker with
    | Open { active; _ } -> choose active resource
    | Closed -> Effect.Ignore
  in
  let view =
    Vdom.Node.div
      ~attrs:[ class_ "composer-wrap" ]
      [
        Vdom.Node.p ~attrs:[ class_ "notice" ] [ text combined_notice ];
        Vdom.Node.form
          ~attrs:
            [
              class_ "composer";
              Vdom.Attr.on_submit (fun _ -> prevent (submit ()));
            ]
          [
            Vdom.Node.textarea
              ~attrs:
                ([
                   Vdom.Attr.id input_id;
                   Vdom.Attr.create "aria-label" "Message agent";
                   Vdom.Attr.create "aria-autocomplete" "list";
                   Vdom.Attr.create "aria-controls" "file-mention-options";
                   Vdom.Attr.create "aria-expanded" (Bool.to_string picker_open);
                   Vdom.Attr.placeholder "Message agent";
                   Vdom.Attr.on_input update_prompt;
                   Vdom.Attr.on_keydown keydown;
                 ]
                @ Option.value_map active_descendant ~default:[] ~f:(fun id ->
                    [ Vdom.Attr.create "aria-activedescendant" id ]))
              [];
            picker_view picker
              ~on_hover:(fun index ->
                set_picker (Mention_picker.select_index picker index))
              ~on_choose;
            Vdom.Node.div
              ~attrs:[ class_ "composer-footer" ]
              [
                Vdom.Node.div
                  ~attrs:[ class_ "composer-insertions" ]
                  [
                    Vdom.Node.button
                      ~attrs:
                        [
                          Vdom.Attr.create "type" "button";
                          Vdom.Attr.create "aria-label"
                            "Mention a workspace file";
                          Vdom.Attr.create "aria-haspopup" "listbox";
                          Vdom.Attr.create "aria-controls"
                            "file-mention-options";
                          Vdom.Attr.create "aria-expanded"
                            (Bool.to_string picker_open);
                          Vdom.Attr.on_mousedown (fun _ ->
                              Vdom.Effect.Prevent_default);
                          Vdom.Attr.on_click (fun _ -> toolbar_mention ());
                        ]
                      [ text "@" ];
                  ];
                config_controls;
                Vdom.Node.button
                  ~attrs:
                    ([
                       class_ "send-action";
                       Vdom.Attr.create "type" "submit";
                       Vdom.Attr.create "aria-label" "Send message";
                     ]
                    @
                    if submitting || String.is_empty (String.strip prompt) then
                      [ Vdom.Attr.create "disabled" "" ]
                    else [])
                  [ text (if submitting then "..." else ">") ];
              ];
          ];
      ]
  in
  {
    view;
    reset =
      (fun () ->
        Mention_request.cancel ();
        apply_to_field { text = ""; cursor = 0 };
        Effect.Many
          [
            set_prompt "";
            set_resources [];
            set_picker Mention_picker.Closed;
            set_notice "";
          ]);
    set_notice;
  }
