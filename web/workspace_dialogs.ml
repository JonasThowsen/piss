open! Core
open! Bonsai_web.Cont
open Bonsai.Let_syntax
open Js_of_ocaml

type dialog = Closed | Add | Remove of Workspace_catalog.workspace

type output = {
  view : Vdom.Node.t;
  open_add : unit -> unit Effect.t;
  open_remove : Workspace_catalog.workspace -> unit Effect.t;
}

let class_ name = Vdom.Attr.class_ name
let text = Vdom.Node.text
let search_generation = ref 0

let key event =
  try
    Js.to_string
      (Js.Unsafe.coerce (Js.Unsafe.get (Js.Unsafe.inject event) "key"))
  with _ -> ""

let path id action =
  Request_target.path_with_id ~prefix:"/api/v2/workspaces/" ~id
    ~suffix:("/" ^ action)

let decode_workspace body =
  match Workspace_catalog.decode ("[" ^ body ^ "]") with
  | Ok [ workspace ] -> Ok workspace
  | Ok _ -> Error "response must contain one workspace"
  | Error message -> Error message

let component ~on_reload graph =
  let dialog, set_dialog = Bonsai.state Closed graph in
  let query, set_query = Bonsai.state "" graph in
  let directories, set_directories = Bonsai.state [] graph in
  let selected, set_selected = Bonsai.state 0 graph in
  let loading, set_loading = Bonsai.state false graph in
  let busy, set_busy = Bonsai.state false graph in
  let error, set_error = Bonsai.state None graph in
  let%arr on_reload = on_reload
  and dialog = dialog
  and query = query
  and directories = directories
  and selected = selected
  and loading = loading
  and busy = busy
  and error = error
  and set_dialog = set_dialog
  and set_query = set_query
  and set_directories = set_directories
  and set_selected = set_selected
  and set_loading = set_loading
  and set_busy = set_busy
  and set_error = set_error in
  let close () =
    if busy then Effect.Ignore
    else Effect.Many [ Modal.deactivate (); set_dialog Closed; set_error None ]
  in
  let search value =
    incr search_generation;
    let generation = !search_generation in
    Effect.bind
      (Effect.Many
         [ set_query value; set_loading true; set_error None; set_selected 0 ])
      ~f:(fun () ->
        Effect.bind
          (Effect.of_deferred_thunk (fun () ->
               Browser_http.get
                 ~query:[ ("query", value) ]
                 "/api/v2/workspace-directories"))
          ~f:(function
            | _ when generation <> !search_generation -> Effect.Ignore
            | Error error ->
                Effect.Many
                  [
                    set_loading false;
                    set_error (Some (Error.to_string_hum error));
                  ]
            | Ok body -> (
                match Workspace_catalog.decode_directories body with
                | Error message ->
                    Effect.Many [ set_loading false; set_error (Some message) ]
                | Ok values ->
                    Effect.Many
                      [
                        set_loading false;
                        set_directories values;
                        set_selected 0;
                      ])))
  in
  let open_add () =
    Effect.bind
      (Effect.Many
         [
           set_dialog Add;
           set_query "";
           set_directories [];
           set_busy false;
           set_error None;
         ])
      ~f:(fun () ->
        Effect.Many
          [
            Modal.activate ~surface_id:"workspace-dialog"
              ~initial_focus:"workspace-directory-query" ~dismissible:true
              ~on_close:close;
            search "";
          ])
  and open_remove workspace =
    Effect.bind
      (Effect.Many
         [ set_dialog (Remove workspace); set_busy false; set_error None ])
      ~f:(fun () ->
        Modal.activate ~surface_id:"workspace-dialog"
          ~initial_focus:"workspace-remove-cancel" ~dismissible:true
          ~on_close:close)
  in
  let fail message =
    Effect.Many
      [ Modal.set_dismissible true; set_busy false; set_error (Some message) ]
  in
  let finish () =
    Effect.bind
      (Effect.Many [ set_busy false; Modal.deactivate (); set_dialog Closed ])
      ~f:(fun () -> on_reload)
  in
  let add () =
    match List.nth directories selected with
    | None -> fail "Choose an approved local directory."
    | Some directory ->
        Effect.bind
          (Effect.Many [ Modal.set_dismissible false; set_busy true ])
          ~f:(fun () ->
            Effect.bind
              (Effect.of_deferred_thunk (fun () ->
                   Browser_http.post_json "/api/v2/workspaces"
                     (`Assoc [ ("path", `String directory.path) ])))
              ~f:(function
                | Error error -> fail (Error.to_string_hum error)
                | Ok body -> (
                    match decode_workspace body with
                    | Error message -> fail message
                    | Ok _ -> finish ())))
  and remove (workspace : Workspace_catalog.workspace) =
    Effect.bind
      (Effect.Many [ Modal.set_dismissible false; set_busy true ])
      ~f:(fun () ->
        Effect.bind
          (Effect.of_deferred_thunk (fun () ->
               Browser_http.post_json (path workspace.id "delete") (`Assoc [])))
          ~f:(function
            | Error error -> fail (Error.to_string_hum error)
            | Ok _ -> finish ()))
  in
  let error_view =
    Option.value_map error ~default:Vdom.Node.none ~f:(fun message ->
        Vdom.Node.p
          ~attrs:[ class_ "dialog-error"; Vdom.Attr.create "role" "alert" ]
          [ text message ])
  in
  let close_button =
    Vdom.Node.button
      ~attrs:
        ([
           class_ "modal-surface-close";
           Vdom.Attr.create "type" "button";
           Vdom.Attr.create "aria-label" "Close";
           Vdom.Attr.on_click (fun _ -> close ());
         ]
        @ if busy then [ Vdom.Attr.disabled ] else [])
      [ text "x" ]
  in
  let view =
    match dialog with
    | Closed -> Vdom.Node.none
    | Add ->
        let title_id = "workspace-dialog-title" in
        let active_id =
          if List.is_empty directories then None
          else Some (Printf.sprintf "workspace-directory-%d" selected)
        in
        let navigate event =
          let count = List.length directories in
          match key event with
          | ("ArrowDown" | "n")
            when (not (String.equal (key event) "n"))
                 || Js.to_bool
                      (Js.Unsafe.coerce
                         (Js.Unsafe.get (Js.Unsafe.inject event) "ctrlKey")) ->
              Effect.Many
                [
                  Vdom.Effect.Prevent_default;
                  set_selected
                    (Global_search.move ~count ~current:selected ~delta:1);
                ]
          | ("ArrowUp" | "p")
            when (not (String.equal (key event) "p"))
                 || Js.to_bool
                      (Js.Unsafe.coerce
                         (Js.Unsafe.get (Js.Unsafe.inject event) "ctrlKey")) ->
              Effect.Many
                [
                  Vdom.Effect.Prevent_default;
                  set_selected
                    (Global_search.move ~count ~current:selected ~delta:(-1));
                ]
          | "Enter" when count > 0 ->
              Effect.Many [ Vdom.Effect.Prevent_default; add () ]
          | _ -> Effect.Ignore
        in
        Modal.surface ~kind:Dialog ~surface_id:"workspace-dialog"
          ~labelled_by:title_id ~class_name:"workspace-dialog"
          ~dismissible:(not busy) ~on_close:close
          [
            Vdom.Node.header
              ~attrs:[ class_ "modal-surface-header" ]
              [
                Vdom.Node.div
                  [
                    Vdom.Node.span
                      ~attrs:[ class_ "modal-surface-label" ]
                      [ text "WORKSPACE" ];
                    Vdom.Node.h2
                      ~attrs:
                        [ Vdom.Attr.id title_id; class_ "modal-surface-title" ]
                      [ text "Add workspace" ];
                  ];
                close_button;
              ];
            Vdom.Node.div
              ~attrs:[ class_ "modal-surface-body" ]
              [
                Vdom.Node.p
                  ~attrs:[ class_ "dialog-help" ]
                  [
                    text
                      "Choose a directory from the local roots approved by \
                       this host.";
                  ];
                Vdom.Node.label
                  [
                    Vdom.Node.span
                      ~attrs:[ class_ "dialog-field-label" ]
                      [ text "Directory" ];
                    Vdom.Node.input
                      ~attrs:
                        ([
                           Vdom.Attr.id "workspace-directory-query";
                           Vdom.Attr.create "role" "combobox";
                           Vdom.Attr.create "aria-label"
                             "Search approved directories";
                           Vdom.Attr.create "aria-controls"
                             "workspace-directory-options";
                           Vdom.Attr.create "aria-expanded" "true";
                           Vdom.Attr.value query;
                           Vdom.Attr.on_input (fun _ value -> search value);
                           Vdom.Attr.on_keydown navigate;
                         ]
                        @ Option.value_map active_id ~default:[] ~f:(fun id ->
                            [ Vdom.Attr.create "aria-activedescendant" id ]))
                      ();
                  ];
                Vdom.Node.div
                  ~attrs:
                    [
                      Vdom.Attr.id "workspace-directory-options";
                      class_ "directory-options";
                      Vdom.Attr.create "role" "listbox";
                      Vdom.Attr.create "aria-label" "Approved directories";
                    ]
                  (if loading then [ Vdom.Node.p [ text "Searching..." ] ]
                   else
                     List.mapi directories ~f:(fun index directory ->
                         Vdom.Node.button ~key:directory.path
                           ~attrs:
                             [
                               Vdom.Attr.id
                                 (Printf.sprintf "workspace-directory-%d" index);
                               Vdom.Attr.create "type" "button";
                               Vdom.Attr.create "role" "option";
                               Vdom.Attr.create "aria-selected"
                                 (Bool.to_string (index = selected));
                               (if index = selected then class_ "selected"
                                else class_ "");
                               Vdom.Attr.on_mouseenter (fun _ ->
                                   set_selected index);
                               Vdom.Attr.on_click (fun _ -> set_selected index);
                             ]
                           [
                             Vdom.Node.strong [ text directory.name ];
                             Vdom.Node.small [ text directory.path ];
                           ]));
                error_view;
              ];
            Vdom.Node.footer
              ~attrs:[ class_ "modal-surface-footer" ]
              [
                Vdom.Node.button
                  ~attrs:
                    [
                      class_ "cancel";
                      Vdom.Attr.create "type" "button";
                      Vdom.Attr.on_click (fun _ -> close ());
                    ]
                  [ text "CANCEL" ];
                Vdom.Node.button
                  ~attrs:
                    ([
                       class_ "launch";
                       Vdom.Attr.create "type" "button";
                       Vdom.Attr.on_click (fun _ -> add ());
                     ]
                    @
                    if busy || List.is_empty directories then
                      [ Vdom.Attr.disabled ]
                    else [])
                  [ text (if busy then "ADDING..." else "ADD WORKSPACE") ];
              ];
          ]
    | Remove workspace ->
        let title_id = "workspace-dialog-title"
        and description_id = "workspace-remove-description" in
        Modal.surface ~kind:Alertdialog ~surface_id:"workspace-dialog"
          ~labelled_by:title_id ~described_by:description_id
          ~class_name:"workspace-remove-dialog" ~dismissible:(not busy)
          ~on_close:close
          [
            Vdom.Node.header
              ~attrs:[ class_ "modal-surface-header" ]
              [
                Vdom.Node.h2
                  ~attrs:[ Vdom.Attr.id title_id; class_ "modal-surface-title" ]
                  [ text "Remove workspace?" ];
                close_button;
              ];
            Vdom.Node.div
              ~attrs:[ class_ "modal-surface-body" ]
              [
                Vdom.Node.p
                  ~attrs:[ Vdom.Attr.id description_id ]
                  [
                    Vdom.Node.strong [ text workspace.name ];
                    text
                      " will be removed from Piss. This does not delete the \
                       directory or any files.";
                  ];
                Vdom.Node.code
                  ~attrs:[ class_ "workspace-remove-path" ]
                  [ text workspace.root ];
                error_view;
              ];
            Vdom.Node.footer
              ~attrs:[ class_ "modal-surface-footer" ]
              [
                Vdom.Node.button
                  ~attrs:
                    ([
                       Vdom.Attr.id "workspace-remove-cancel";
                       class_ "cancel";
                       Vdom.Attr.create "type" "button";
                       Vdom.Attr.on_click (fun _ -> close ());
                     ]
                    @ if busy then [ Vdom.Attr.disabled ] else [])
                  [ text "CANCEL" ];
                Vdom.Node.button
                  ~attrs:
                    ([
                       class_ "danger-action";
                       Vdom.Attr.create "type" "button";
                       Vdom.Attr.on_click (fun _ -> remove workspace);
                     ]
                    @ if busy then [ Vdom.Attr.disabled ] else [])
                  [ text (if busy then "REMOVING..." else "REMOVE WORKSPACE") ];
              ];
          ]
  in
  { view; open_add; open_remove }
