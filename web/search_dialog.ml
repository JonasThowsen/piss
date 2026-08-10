open! Core
open! Bonsai_web.Cont
open Bonsai.Let_syntax
open Js_of_ocaml

type output = {
  trigger : Vdom.Node.t;
  view : Vdom.Node.t;
  close : unit Effect.t;
}

let class_ name = Vdom.Attr.class_ name
let text = Vdom.Node.text

let search_icon () =
  Vdom.Node.create "svg"
    ~attrs:
      [
        Vdom.Attr.create "viewBox" "0 0 24 24";
        Vdom.Attr.create "fill" "none";
        Vdom.Attr.create "stroke" "currentColor";
        Vdom.Attr.create "stroke-width" "1.8";
        Vdom.Attr.create "stroke-linecap" "round";
        Vdom.Attr.create "stroke-linejoin" "round";
        Vdom.Attr.create "aria-hidden" "true";
      ]
    [
      Vdom.Node.create "circle"
        ~attrs:
          [
            Vdom.Attr.create "cx" "11";
            Vdom.Attr.create "cy" "11";
            Vdom.Attr.create "r" "7";
          ]
        [];
      Vdom.Node.create "path"
        ~attrs:[ Vdom.Attr.create "d" "m20 20-3.5-3.5" ]
        [];
    ]

let shortcut_listener : Js.Unsafe.any option ref = ref None
let dispatch action = Vdom.Effect.Expert.handle_non_dom_event_exn action

let event_key event =
  try
    Js.to_string
      (Js.Unsafe.coerce (Js.Unsafe.get (Js.Unsafe.inject event) "key"))
  with _ -> ""

let event_bool event name =
  try
    Js.to_bool (Js.Unsafe.coerce (Js.Unsafe.get (Js.Unsafe.inject event) name))
  with _ -> false

let remove_shortcut () =
  Option.iter !shortcut_listener ~f:(fun listener ->
      ignore
        (Js.Unsafe.meth_call
           (Js.Unsafe.inject Dom_html.document)
           "removeEventListener"
           [| Js.Unsafe.inject (Js.string "keydown"); listener |]));
  shortcut_listener := None

let install_shortcut open_ =
  remove_shortcut ();
  let listener =
    Js.wrap_callback (fun event ->
        if
          String.Caseless.equal (event_key event) "k"
          && (event_bool event "ctrlKey" || event_bool event "metaKey")
          && not (event_bool event "altKey")
        then (
          ignore
            (Js.Unsafe.meth_call (Js.Unsafe.inject event) "preventDefault" [||]);
          dispatch (open_ ())))
    |> Js.Unsafe.inject
  in
  ignore
    (Js.Unsafe.meth_call
       (Js.Unsafe.inject Dom_html.document)
       "addEventListener"
       [| Js.Unsafe.inject (Js.string "keydown"); listener |]);
  shortcut_listener := Some listener

let cleanup () =
  Effect.of_deferred_thunk (fun () ->
      remove_shortcut ();
      Async_kernel.Deferred.return ())

let option_id index = Printf.sprintf "global-session-option-%d" index

let component ~workspaces ~active ~archived ~on_open ~on_reload:_ ~on_select
    graph =
  let open_state, set_open = Bonsai.state false graph in
  let scope, set_scope = Bonsai.state Global_search.Active graph in
  let query, set_query = Bonsai.state "" graph in
  let selected, set_selected = Bonsai.state 0 graph in
  let busy, set_busy = Bonsai.state false graph in
  let error, set_error = Bonsai.state None graph in
  let values =
    let%arr scope = scope
    and query = query
    and workspaces = workspaces
    and active = active
    and archived = archived in
    Global_search.items ~scope ~query ~workspaces ~active ~archived
  in
  let shortcut_open =
    let%arr open_state = open_state
    and set_open = set_open
    and set_scope = set_scope
    and set_query = set_query
    and set_selected = set_selected
    and set_busy = set_busy
    and set_error = set_error
    and on_open = on_open in
    fun () ->
      if open_state then Effect.Ignore
      else
        let close () =
          Effect.Many [ Modal.deactivate (); set_open false; set_error None ]
        in
        Effect.bind
          (Effect.Many
             [
               set_open true;
               set_scope Global_search.Active;
               set_query "";
               set_selected 0;
               set_busy false;
               set_error None;
               on_open;
             ])
          ~f:(fun () ->
            Modal.activate ~surface_id:"global-search-dialog"
              ~initial_focus:"global-session-query" ~dismissible:true
              ~on_close:close)
  in
  let on_activate =
    let%map open_ = shortcut_open in
    Effect.of_deferred_thunk (fun () ->
        install_shortcut open_;
        Async_kernel.Deferred.return ())
  in
  Bonsai.Edge.lifecycle ~on_activate
    ~on_deactivate:(Bonsai.return (cleanup ()))
    graph;
  let%arr active = active
  and archived = archived
  and on_select = on_select
  and open_state = open_state
  and scope = scope
  and query = query
  and selected = selected
  and busy = busy
  and error = error
  and values = values
  and shortcut_open = shortcut_open
  and set_open = set_open
  and set_scope = set_scope
  and set_query = set_query
  and set_selected = set_selected
  and set_busy = set_busy
  and set_error = set_error in
  let close () =
    if busy then Effect.Ignore
    else Effect.Many [ Modal.deactivate (); set_open false; set_error None ]
  in
  let open_ = shortcut_open in
  let finish id =
    Effect.bind
      (Effect.Many [ set_busy false; Modal.deactivate (); set_open false ])
      ~f:(fun () -> on_select id)
  in
  let choose (item : Global_search.item) =
    if busy then Effect.Ignore
    else
      match scope with
      | Active ->
          Effect.bind
            (Effect.Many [ Modal.deactivate (); set_open false ])
            ~f:(fun () -> on_select item.session.id)
      | Archived ->
          Effect.bind
            (Effect.Many
               [ Modal.set_dismissible false; set_busy true; set_error None ])
            ~f:(fun () ->
              Effect.bind
                (Effect.of_deferred_thunk (fun () ->
                     Session_lifecycle.restore_and_wait item.session.id))
                ~f:(function
                  | Error message ->
                      Effect.Many
                        [
                          Modal.set_dismissible true;
                          set_busy false;
                          set_error (Some message);
                        ]
                  | Ok () -> finish item.session.id))
  in
  let navigate event =
    let count = List.length values in
    let key = event_key event in
    let delta =
      match key with
      | "ArrowDown" -> Some 1
      | "ArrowUp" -> Some (-1)
      | "n" when event_bool event "ctrlKey" -> Some 1
      | "p" when event_bool event "ctrlKey" -> Some (-1)
      | _ -> None
    in
    match delta with
    | Some delta ->
        Effect.Many
          [
            Vdom.Effect.Prevent_default;
            set_selected (Global_search.move ~count ~current:selected ~delta);
          ]
    | None when String.equal key "Enter" -> (
        match List.nth values selected with
        | None -> Effect.Ignore
        | Some item -> Effect.Many [ Vdom.Effect.Prevent_default; choose item ])
    | None -> Effect.Ignore
  in
  let trigger =
    Vdom.Node.button
      ~attrs:
        [
          class_ "search-trigger";
          Vdom.Attr.create "type" "button";
          Vdom.Attr.create "aria-label" "Search sessions";
          Vdom.Attr.create "title" "Search sessions (Ctrl/Cmd+K)";
          Vdom.Attr.on_click (fun _ -> open_ ());
        ]
      [
        search_icon ();
        Vdom.Node.span [ text "Search sessions" ];
        Vdom.Node.kbd [ text "Ctrl/Cmd+K" ];
      ]
  in
  let view =
    if not open_state then Vdom.Node.none
    else
      let title_id = "global-search-title" in
      let active_descendant =
        if List.is_empty values then []
        else [ Vdom.Attr.create "aria-activedescendant" (option_id selected) ]
      in
      Modal.surface ~kind:Dialog ~surface_id:"global-search-dialog"
        ~labelled_by:title_id ~class_name:"global-search-dialog"
        ~dismissible:(not busy) ~on_close:close
        [
          Vdom.Node.header
            ~attrs:[ class_ "modal-surface-header" ]
            [
              Vdom.Node.div
                [
                  Vdom.Node.span
                    ~attrs:[ class_ "modal-surface-label" ]
                    [ text "ALL WORKSPACES" ];
                  Vdom.Node.h2
                    ~attrs:
                      [ Vdom.Attr.id title_id; class_ "modal-surface-title" ]
                    [ text "Search sessions" ];
                ];
              Vdom.Node.button
                ~attrs:
                  ([
                     class_ "modal-surface-close";
                     Vdom.Attr.create "type" "button";
                     Vdom.Attr.create "aria-label" "Close session search";
                     Vdom.Attr.on_click (fun _ -> close ());
                   ]
                  @ if busy then [ Vdom.Attr.disabled ] else [])
                [ text "x" ];
            ];
          Vdom.Node.div
            ~attrs:[ class_ "modal-surface-body" ]
            [
              Vdom.Node.div
                ~attrs:[ class_ "global-search-scope" ]
                [
                  Vdom.Node.button
                    ~attrs:
                      [
                        class_
                          (if phys_equal scope Active then "active" else "");
                        Vdom.Attr.create "type" "button";
                        Vdom.Attr.create "aria-pressed"
                          (Bool.to_string (phys_equal scope Active));
                        Vdom.Attr.on_click (fun _ ->
                            Effect.Many [ set_scope Active; set_selected 0 ]);
                      ]
                    [ text (Printf.sprintf "Active (%d)" (List.length active)) ];
                  Vdom.Node.button
                    ~attrs:
                      [
                        class_
                          (if phys_equal scope Archived then "active" else "");
                        Vdom.Attr.create "type" "button";
                        Vdom.Attr.create "aria-pressed"
                          (Bool.to_string (phys_equal scope Archived));
                        Vdom.Attr.on_click (fun _ ->
                            Effect.Many [ set_scope Archived; set_selected 0 ]);
                      ]
                    [
                      text
                        (Printf.sprintf "Archived (%d)" (List.length archived));
                    ];
                ];
              Vdom.Node.div
                ~attrs:[ class_ "global-search-field" ]
                [
                  Vdom.Node.input
                    ~attrs:
                      ([
                         Vdom.Attr.id "global-session-query";
                         Vdom.Attr.create "role" "combobox";
                         Vdom.Attr.create "aria-label" "Search sessions";
                         Vdom.Attr.create "aria-controls"
                           "global-session-results";
                         Vdom.Attr.create "aria-expanded" "true";
                         Vdom.Attr.create "autocomplete" "off";
                         Vdom.Attr.placeholder
                           "Title, ID, harness, status, or workspace";
                         Vdom.Attr.value query;
                         Vdom.Attr.on_input (fun _ value ->
                             Effect.Many [ set_query value; set_selected 0 ]);
                         Vdom.Attr.on_keydown navigate;
                       ]
                      @ active_descendant)
                    ();
                ];
              Vdom.Node.div
                ~attrs:
                  [
                    Vdom.Attr.id "global-session-results";
                    class_ "global-search-results";
                    Vdom.Attr.create "role" "listbox";
                    Vdom.Attr.create "aria-label"
                      (if phys_equal scope Active then "Active sessions"
                       else "Archived sessions");
                  ]
                (if List.is_empty values then
                   [
                     Vdom.Node.div
                       ~attrs:[ class_ "global-search-empty" ]
                       [
                         Vdom.Node.b
                           [
                             text
                               (if String.is_empty query then "No sessions"
                                else "No matching sessions");
                           ];
                         Vdom.Node.span
                           [
                             text
                               "Search by session, workspace, harness, or \
                                status.";
                           ];
                       ];
                   ]
                 else
                   List.mapi values ~f:(fun index (item : Global_search.item) ->
                       let workspace =
                         Option.value_map item.workspace
                           ~default:"Unknown workspace" ~f:(fun value ->
                             value.name ^ " / " ^ value.root)
                       in
                       Vdom.Node.button ~key:item.session.id
                         ~attrs:
                           [
                             Vdom.Attr.id (option_id index);
                             Vdom.Attr.create "type" "button";
                             Vdom.Attr.create "role" "option";
                             Vdom.Attr.create "aria-selected"
                               (Bool.to_string (index = selected));
                             Vdom.Attr.on_mouseenter (fun _ ->
                                 set_selected index);
                             Vdom.Attr.on_mousedown (fun _ ->
                                 Vdom.Effect.Prevent_default);
                             Vdom.Attr.on_click (fun _ -> choose item);
                           ]
                         [
                           Vdom.Node.create "i"
                             ~attrs:
                               [
                                 class_ "global-search-glyph";
                                 Vdom.Attr.create "aria-hidden" "true";
                               ]
                             [
                               text
                                 (if phys_equal scope Active then ">" else "A");
                             ];
                           Vdom.Node.span
                             [
                               Vdom.Node.b [ text item.session.title ];
                               Vdom.Node.small
                                 [ text (item.session.id ^ " / " ^ workspace) ];
                             ];
                           Vdom.Node.em
                             [
                               text
                                 (Control_plane.Session.status_to_string
                                    item.session.status);
                             ];
                         ]));
              Option.value_map error ~default:Vdom.Node.none ~f:(fun message ->
                  Vdom.Node.p
                    ~attrs:
                      [ class_ "dialog-error"; Vdom.Attr.create "role" "alert" ]
                    [ text message ]);
            ];
        ]
  in
  { trigger; view; close = close () }
