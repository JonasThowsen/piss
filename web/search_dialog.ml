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
  Vdom.Node.create_svg "svg"
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
      Vdom.Node.create_svg "circle"
        ~attrs:
          [
            Vdom.Attr.create "cx" "11";
            Vdom.Attr.create "cy" "11";
            Vdom.Attr.create "r" "7";
          ]
        [];
      Vdom.Node.create_svg "path"
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

let present value =
  Js.to_bool
    (Js.Unsafe.coerce
       (Js.Unsafe.fun_call
          (Js.Unsafe.get (Js.Unsafe.inject Dom_html.window) "Boolean")
          [| value |]))

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

let reveal_option index =
  Effect.of_deferred_thunk (fun () ->
      let callback =
        Js.wrap_callback (fun () ->
            let element =
              Js.Unsafe.meth_call
                (Js.Unsafe.inject Dom_html.document)
                "getElementById"
                [| Js.Unsafe.inject (Js.string (option_id index)) |]
            in
            if present element then
              let options =
                Js.Unsafe.obj
                  [|
                    ("block", Js.Unsafe.inject (Js.string "nearest"));
                    ("inline", Js.Unsafe.inject (Js.string "nearest"));
                  |]
              in
              ignore
                (Js.Unsafe.meth_call element "scrollIntoView"
                   [| Js.Unsafe.inject options |]))
      in
      ignore
        (Js.Unsafe.meth_call
           (Js.Unsafe.inject Dom_html.window)
           "requestAnimationFrame"
           [| Js.Unsafe.inject callback |]);
      Async_kernel.Deferred.return ())

let component ~workspaces ~active ~archived ~seen_finished_at ~on_open
    ~on_reload ~on_select graph =
  let open_state, set_open = Bonsai.state false graph in
  let scope, set_scope = Bonsai.state Global_search.Active graph in
  let query, set_query = Bonsai.state "" graph in
  let selected, set_selected = Bonsai.state 0 graph in
  let busy, set_busy = Bonsai.state false graph in
  let error, set_error = Bonsai.state None graph in
  let selected_sessions, set_selected_sessions =
    Bonsai.state String.Set.empty graph
  in
  let confirm_delete, set_confirm_delete = Bonsai.state false graph in
  let delete_all, set_delete_all = Bonsai.state false graph in
  let values =
    let%arr scope = scope
    and query = query
    and workspaces = workspaces
    and active = active
    and archived = archived
    and seen_finished_at = seen_finished_at in
    Global_search.items ~scope ~query ~seen_finished_at ~workspaces ~active
      ~archived
  in
  let shortcut_open =
    let%arr open_state = open_state
    and set_open = set_open
    and set_scope = set_scope
    and set_query = set_query
    and set_selected = set_selected
    and set_busy = set_busy
    and set_error = set_error
    and set_selected_sessions = set_selected_sessions
    and set_confirm_delete = set_confirm_delete
    and set_delete_all = set_delete_all
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
               set_selected_sessions String.Set.empty;
               set_confirm_delete false;
               set_delete_all false;
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
  and seen_finished_at = seen_finished_at
  and on_reload = on_reload
  and on_select = on_select
  and open_state = open_state
  and scope = scope
  and query = query
  and selected = selected
  and busy = busy
  and error = error
  and selected_sessions = selected_sessions
  and confirm_delete = confirm_delete
  and delete_all = delete_all
  and values = values
  and shortcut_open = shortcut_open
  and set_open = set_open
  and set_scope = set_scope
  and set_query = set_query
  and set_selected = set_selected
  and set_busy = set_busy
  and set_error = set_error
  and set_selected_sessions = set_selected_sessions
  and set_confirm_delete = set_confirm_delete
  and set_delete_all = set_delete_all in
  let selected =
    if selected >= 0 && selected < List.length values then selected else 0
  in
  let close () =
    if busy then Effect.Ignore
    else
      Effect.Many
        [
          Modal.deactivate ();
          set_open false;
          set_error None;
          set_selected_sessions String.Set.empty;
          set_confirm_delete false;
          set_delete_all false;
        ]
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
  let show_delete_confirmation ~all =
    if
      busy || List.is_empty archived
      || ((not all) && Set.is_empty selected_sessions)
    then Effect.Ignore
    else
      Effect.bind
        (Effect.Many
           [ set_confirm_delete true; set_delete_all all; set_error None ])
        ~f:(fun () ->
          Modal.activate ~surface_id:"global-search-dialog"
            ~initial_focus:"delete-archived-cancel" ~dismissible:true
            ~on_close:close)
  in
  let cancel_delete () =
    if busy then Effect.Ignore
    else
      Effect.bind
        (Effect.Many [ set_confirm_delete false; set_error None ])
        ~f:(fun () ->
          Modal.activate ~surface_id:"global-search-dialog"
            ~initial_focus:"global-session-query" ~dismissible:true
            ~on_close:close)
  in
  let delete_archived () =
    if busy then Effect.Ignore
    else
      Effect.bind
        (Effect.Many
           [ Modal.set_dismissible false; set_busy true; set_error None ])
        ~f:(fun () ->
          Effect.bind
            (Effect.of_deferred_thunk (fun () ->
                 let body =
                   if delete_all then `Assoc []
                   else
                     `Assoc
                       [
                         ( "ids",
                           `List
                             (Set.to_list selected_sessions
                             |> List.map ~f:(fun id -> `String id)) );
                       ]
                 in
                 Browser_http.post_json "/api/v2/sessions/delete-archived" body))
            ~f:(function
              | Error error ->
                  Effect.Many
                    [
                      Modal.set_dismissible true;
                      set_busy false;
                      set_error (Some (Error.to_string_hum error));
                    ]
              | Ok _ ->
                  Effect.bind
                    (Effect.Many
                       [
                         set_busy false;
                         Modal.deactivate ();
                         set_open false;
                         set_selected_sessions String.Set.empty;
                         set_confirm_delete false;
                         set_delete_all false;
                       ])
                    ~f:(fun () -> on_reload)))
  in
  let toggle_session id =
    set_selected_sessions
      (if Set.mem selected_sessions id then Set.remove selected_sessions id
       else Set.add selected_sessions id)
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
        let next = Global_search.move_clamped ~count ~current:selected ~delta in
        Effect.Many
          [ Vdom.Effect.Prevent_default; set_selected next; reveal_option next ]
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
    else if confirm_delete then
      let delete_count =
        if delete_all then List.length archived
        else Set.length selected_sessions
      in
      let title_id = "delete-archived-title"
      and description_id = "delete-archived-description" in
      Modal.surface ~kind:Alertdialog ~surface_id:"global-search-dialog"
        ~labelled_by:title_id ~described_by:description_id
        ~class_name:"archive-dialog" ~dismissible:(not busy)
        ~on_close:cancel_delete
        [
          Vdom.Node.form
            ~attrs:
              [
                Vdom.Attr.on_submit (fun _ ->
                    Effect.Many
                      [ Vdom.Effect.Prevent_default; delete_archived () ]);
              ]
            [
              Vdom.Node.header
                ~attrs:[ class_ "modal-surface-header" ]
                [
                  Vdom.Node.div
                    [
                      Vdom.Node.span
                        ~attrs:[ class_ "modal-surface-label" ]
                        [ text "ARCHIVED SESSIONS" ];
                      Vdom.Node.h2
                        ~attrs:
                          [
                            Vdom.Attr.id title_id; class_ "modal-surface-title";
                          ]
                        [
                          text
                            (if delete_all then "Delete archived sessions?"
                             else "Delete selected sessions?");
                        ];
                    ];
                  Vdom.Node.button
                    ~attrs:
                      ([
                         class_ "modal-surface-close";
                         Vdom.Attr.create "type" "button";
                         Vdom.Attr.create "aria-label" "Close";
                         Vdom.Attr.on_click (fun _ -> cancel_delete ());
                       ]
                      @ if busy then [ Vdom.Attr.disabled ] else [])
                    [ text "x" ];
                ];
              Vdom.Node.div
                ~attrs:[ class_ "modal-surface-body" ]
                [
                  Vdom.Node.p
                    ~attrs:[ Vdom.Attr.id description_id ]
                    [
                      text
                        (Printf.sprintf
                           "%d %sarchived %s and all of their conversation \
                            data will be permanently deleted. This cannot be \
                            undone."
                           delete_count
                           (if delete_all then "" else "selected ")
                           (if delete_count = 1 then "session" else "sessions"));
                    ];
                  Option.value_map error ~default:Vdom.Node.none
                    ~f:(fun message ->
                      Vdom.Node.p
                        ~attrs:
                          [
                            class_ "dialog-error";
                            Vdom.Attr.create "role" "alert";
                          ]
                        [ text message ]);
                ];
              Vdom.Node.footer
                ~attrs:[ class_ "modal-surface-footer" ]
                [
                  Vdom.Node.button
                    ~attrs:
                      ([
                         Vdom.Attr.id "delete-archived-cancel";
                         class_ "cancel";
                         Vdom.Attr.create "type" "button";
                         Vdom.Attr.on_click (fun _ -> cancel_delete ());
                       ]
                      @ if busy then [ Vdom.Attr.disabled ] else [])
                    [ text "CANCEL" ];
                  Vdom.Node.button
                    ~attrs:
                      ([
                         class_ "danger-action";
                         Vdom.Attr.create "type" "submit";
                       ]
                      @ if busy then [ Vdom.Attr.disabled ] else [])
                    [
                      text
                        (if busy then "DELETING..."
                         else if delete_all then "DELETE ARCHIVED SESSIONS"
                         else "DELETE SELECTED SESSIONS");
                    ];
                ];
            ];
        ]
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
          Vdom.Node.div
            ~attrs:[ class_ "modal-surface-body" ]
            [
              Vdom.Node.h2
                ~attrs:[ Vdom.Attr.id title_id; class_ "visually-hidden" ]
                [ text "Search sessions" ];
              Vdom.Node.div
                ~attrs:[ class_ "global-search-toolbar" ]
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
                                Effect.Many
                                  [
                                    set_scope Active;
                                    set_selected 0;
                                    reveal_option 0;
                                  ]);
                          ]
                        [
                          text
                            (Printf.sprintf "Active (%d)" (List.length active));
                        ];
                      Vdom.Node.button
                        ~attrs:
                          [
                            class_
                              (if phys_equal scope Archived then "active"
                               else "");
                            Vdom.Attr.create "type" "button";
                            Vdom.Attr.create "aria-pressed"
                              (Bool.to_string (phys_equal scope Archived));
                            Vdom.Attr.on_click (fun _ ->
                                Effect.Many
                                  [
                                    set_scope Archived;
                                    set_selected 0;
                                    reveal_option 0;
                                  ]);
                          ]
                        [
                          text
                            (Printf.sprintf "Archived (%d)"
                               (List.length archived));
                        ];
                    ];
                  Vdom.Node.button
                    ~attrs:
                      ([
                         class_ "global-search-close";
                         Vdom.Attr.create "type" "button";
                         Vdom.Attr.create "aria-label" "Close session search";
                         Vdom.Attr.on_click (fun _ -> close ());
                       ]
                      @ if busy then [ Vdom.Attr.disabled ] else [])
                    [ text "×" ];
                ];
              (if phys_equal scope Archived && not (List.is_empty archived) then
                 Vdom.Node.div
                   ~attrs:
                     [
                       class_
                         (if Set.is_empty selected_sessions then
                            "global-search-delete-actions"
                          else "global-search-delete-actions has-selection");
                     ]
                   ([
                      Vdom.Node.button
                        ~attrs:
                          [
                            class_ "global-search-delete-archived";
                            Vdom.Attr.create "type" "button";
                            Vdom.Attr.on_click (fun _ ->
                                show_delete_confirmation ~all:true);
                          ]
                        [ text "Delete all archived sessions" ];
                    ]
                   @
                   if Set.is_empty selected_sessions then []
                   else
                     [
                       Vdom.Node.button
                         ~attrs:
                           [
                             class_ "global-search-delete-archived selected";
                             Vdom.Attr.create "type" "button";
                             Vdom.Attr.on_click (fun _ ->
                                 show_delete_confirmation ~all:false);
                           ]
                         [
                           text
                             (Printf.sprintf "Delete selected (%d)"
                                (Set.length selected_sessions));
                         ];
                     ])
               else Vdom.Node.none);
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
                             Effect.Many
                               [
                                 set_query value;
                                 set_selected 0;
                                 reveal_option 0;
                               ]);
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
                             value.name)
                       in
                       let details =
                         [
                           Vdom.Node.span
                             [
                               Vdom.Node.b [ text item.session.title ];
                               Vdom.Node.small
                                 [ text (workspace ^ " / " ^ item.session.id) ];
                             ];
                           Vdom.Node.em
                             [
                               text
                                 (Global_search.status_label ~seen_finished_at
                                    item.session);
                             ];
                         ]
                       in
                       if phys_equal scope Active then
                         Vdom.Node.button ~key:item.session.id
                           ~attrs:
                             [
                               Vdom.Attr.id (option_id index);
                               class_
                                 "global-search-option \
                                  global-search-active-option";
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
                           details
                       else
                         let marked =
                           Set.mem selected_sessions item.session.id
                         in
                         Vdom.Node.div ~key:item.session.id
                           ~attrs:
                             [
                               class_ "global-search-result";
                               Vdom.Attr.create "role" "presentation";
                             ]
                           [
                             Vdom.Node.button
                               ~attrs:
                                 [
                                   class_ "global-search-select";
                                   Vdom.Attr.create "type" "button";
                                   Vdom.Attr.create "aria-label"
                                     ((if marked then "Deselect" else "Select")
                                     ^ " archived session " ^ item.session.title
                                     );
                                   Vdom.Attr.create "aria-pressed"
                                     (Bool.to_string marked);
                                   Vdom.Attr.on_mousedown (fun _ ->
                                       Vdom.Effect.Prevent_default);
                                   Vdom.Attr.on_click (fun _ ->
                                       toggle_session item.session.id);
                                 ]
                               [
                                 Vdom.Node.span
                                   ~attrs:[ class_ "global-search-checkmark" ]
                                   [ text (if marked then "✓" else "") ];
                               ];
                             Vdom.Node.button
                               ~attrs:
                                 [
                                   Vdom.Attr.id (option_id index);
                                   class_ "global-search-option";
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
                               details;
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
