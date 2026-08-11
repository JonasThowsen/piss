open! Core
open! Bonsai_web.Cont
open Bonsai.Let_syntax
open Js_of_ocaml

type dialog =
  | Closed
  | Create of Workspace_catalog.workspace
  | Rename of Control_plane.Session.t
  | Archive of Control_plane.Session.t

type output = {
  view : Vdom.Node.t;
  open_create : Workspace_catalog.workspace -> unit Effect.t;
  open_rename : Control_plane.Session.t -> unit Effect.t;
  open_archive : Control_plane.Session.t -> unit Effect.t;
}

let class_ name = Vdom.Attr.class_ name
let text = Vdom.Node.text

let valid_title value =
  String.length (String.strip value) |> Int.between ~low:1 ~high:120

let delay milliseconds =
  let pending = Async_kernel.Ivar.create () in
  let callback =
    Js.wrap_callback (fun () -> Async_kernel.Ivar.fill_if_empty pending ())
  in
  ignore
    (Js.Unsafe.meth_call
       (Js.Unsafe.inject Dom_html.window)
       "setTimeout"
       [| Js.Unsafe.inject callback; Js.Unsafe.inject milliseconds |]);
  Async_kernel.Ivar.read pending

let action_path id action =
  Request_target.path_with_id ~prefix:"/api/v2/sessions/" ~id
    ~suffix:("/" ^ action)

let rec wait_ready id remaining =
  if remaining = 0 then
    Async_kernel.Deferred.return
      (Error "Session did not become ready after 40 attempts")
  else
    let open Async_kernel.Deferred.Let_syntax in
    let%bind () = delay 250 in
    let%bind response =
      Browser_http.get ~query:[ ("session", id) ] "/api/v2/session"
    in
    match response with
    | Ok body -> (
        match Runtime_domain.decode ~expected_session:id body with
        | Ok _ -> Async_kernel.Deferred.return (Ok ())
        | Error _ -> wait_ready id (remaining - 1))
    | Error _ -> wait_ready id (remaining - 1)

let restore_and_wait id =
  let open Async_kernel.Deferred.Let_syntax in
  let%bind restored =
    Browser_http.post_json (action_path id "restore") (`Assoc [])
  in
  match restored with
  | Error error ->
      Async_kernel.Deferred.return (Error (Error.to_string_hum error))
  | Ok _ -> wait_ready id 40

let create ~workspace_id ~title ~harness =
  let open Async_kernel.Deferred.Let_syntax in
  let%bind response =
    Browser_http.post_json "/api/v2/sessions"
      (`Assoc
         [
           ("workspaceId", `String workspace_id);
           ("title", `String (String.strip title));
           ("harness", `String (Control_plane.Session.harness_to_string harness));
         ])
  in
  match response with
  | Error error ->
      Async_kernel.Deferred.return (Error (Error.to_string_hum error))
  | Ok body -> (
      match Control_plane.decode_created_session_id body with
      | Error message -> Async_kernel.Deferred.return (Error message)
      | Ok id ->
          let%map ready = wait_ready id 40 in
          Result.map ready ~f:(fun () -> id))

let mutate id action json =
  let open Async_kernel.Deferred.Let_syntax in
  let%map response = Browser_http.post_json (action_path id action) json in
  Result.map_error response ~f:Error.to_string_hum |> Result.map ~f:ignore

let header ~title_id eyebrow title close ~busy =
  Vdom.Node.header
    ~attrs:[ class_ "modal-surface-header" ]
    [
      Vdom.Node.div
        [
          Vdom.Node.span
            ~attrs:[ class_ "modal-surface-label" ]
            [ text eyebrow ];
          Vdom.Node.h2
            ~attrs:[ Vdom.Attr.id title_id; class_ "modal-surface-title" ]
            [ text title ];
        ];
      Vdom.Node.button
        ~attrs:
          ([
             class_ "modal-surface-close";
             Vdom.Attr.create "type" "button";
             Vdom.Attr.create "aria-label" "Close";
             Vdom.Attr.on_click (fun _ -> close ());
           ]
          @ if busy then [ Vdom.Attr.disabled ] else [])
        [ text "x" ];
    ]

let footer ~close ~busy ~danger label pending_label =
  Vdom.Node.footer
    ~attrs:[ class_ "modal-surface-footer" ]
    [
      Vdom.Node.button
        ~attrs:
          ([
             class_ "cancel";
             Vdom.Attr.create "type" "button";
             Vdom.Attr.on_click (fun _ -> close ());
           ]
          @ if busy then [ Vdom.Attr.disabled ] else [])
        [ text "CANCEL" ];
      Vdom.Node.button
        ~attrs:
          ([
             class_ (if danger then "danger-action" else "launch");
             Vdom.Attr.create "type" "submit";
           ]
          @ if busy then [ Vdom.Attr.disabled ] else [])
        [ text (if busy then pending_label else label) ];
    ]

let component ~creation_options ~on_reload ~on_select graph =
  let dialog, set_dialog = Bonsai.state Closed graph in
  let title, set_title = Bonsai.state "" graph in
  let harness, set_harness = Bonsai.state None graph in
  let busy, set_busy = Bonsai.state false graph in
  let error, set_error = Bonsai.state None graph in
  let%arr creation_options = creation_options
  and on_reload = on_reload
  and on_select = on_select
  and dialog = dialog
  and title = title
  and harness = harness
  and busy = busy
  and error = error
  and set_dialog = set_dialog
  and set_title = set_title
  and set_harness = set_harness
  and set_busy = set_busy
  and set_error = set_error in
  let harnesses =
    Option.value_map creation_options ~default:[] ~f:(fun options ->
        options.Control_plane.Session_creation.available_harnesses)
  in
  let close () =
    if busy then Effect.Ignore
    else Effect.Many [ Modal.deactivate (); set_dialog Closed; set_error None ]
  in
  let activate next initial_focus =
    Effect.bind
      (Effect.Many [ set_dialog next; set_busy false; set_error None ])
      ~f:(fun () ->
        Modal.activate ~surface_id:"session-lifecycle-dialog" ~initial_focus
          ~dismissible:true ~on_close:close)
  in
  let open_create workspace =
    let selected =
      Option.map creation_options ~f:(fun options ->
          options.Control_plane.Session_creation.default_harness)
    in
    Effect.bind
      (Effect.Many
         [
           set_title "";
           set_harness selected;
           activate (Create workspace) "session-title";
         ])
      ~f:(fun () -> Effect.Ignore)
  and open_rename session =
    Effect.Many
      [
        set_title session.Control_plane.Session.title;
        activate (Rename session) "session-title";
      ]
  and open_archive session = activate (Archive session) "archive-cancel" in
  let fail message =
    Effect.Many
      [ Modal.set_dismissible true; set_busy false; set_error (Some message) ]
  in
  let finish ?select () =
    Effect.bind
      (Effect.Many [ set_busy false; Modal.deactivate (); set_dialog Closed ])
      ~f:(fun () ->
        match select with None -> on_reload | Some id -> on_select id)
  in
  let submit =
    if busy then Effect.Ignore
    else
      match dialog with
      | Closed -> Effect.Ignore
      | Create workspace -> (
          match harness with
          | None -> fail "No available session harness was discovered."
          | Some _ when not (valid_title title) ->
              fail "Session title must contain between 1 and 120 characters."
          | Some harness ->
              Effect.bind
                (Effect.Many [ Modal.set_dismissible false; set_busy true ])
                ~f:(fun () ->
                  Effect.bind
                    (Effect.of_deferred_thunk (fun () ->
                         create ~workspace_id:workspace.id ~title ~harness))
                    ~f:(function
                      | Error message -> fail message
                      | Ok id -> finish ~select:id ())))
      | Rename session ->
          if not (valid_title title) then
            fail "Session title must contain between 1 and 120 characters."
          else
            Effect.bind
              (Effect.Many [ Modal.set_dismissible false; set_busy true ])
              ~f:(fun () ->
                Effect.bind
                  (Effect.of_deferred_thunk (fun () ->
                       mutate session.id "rename"
                         (`Assoc [ ("title", `String (String.strip title)) ])))
                  ~f:(function
                    | Error message -> fail message | Ok () -> finish ()))
      | Archive session ->
          Effect.bind
            (Effect.Many [ Modal.set_dismissible false; set_busy true ])
            ~f:(fun () ->
              Effect.bind
                (Effect.of_deferred_thunk (fun () ->
                     mutate session.id "archive" (`Assoc [])))
                ~f:(function
                  | Error message -> fail message | Ok () -> finish ()))
  in
  let error_view =
    Option.value_map error ~default:Vdom.Node.none ~f:(fun message ->
        Vdom.Node.p
          ~attrs:[ class_ "dialog-error"; Vdom.Attr.create "role" "alert" ]
          [ text message ])
  in
  let view =
    match dialog with
    | Closed -> Vdom.Node.none
    | Create workspace ->
        let title_id = "session-lifecycle-title" in
        Modal.surface ~kind:Dialog ~surface_id:"session-lifecycle-dialog"
          ~labelled_by:title_id ~class_name:"session-dialog"
          ~dismissible:(not busy) ~on_close:close
          [
            Vdom.Node.form
              ~attrs:
                [
                  Vdom.Attr.on_submit (fun _ ->
                      Effect.Many [ Vdom.Effect.Prevent_default; submit ]);
                ]
              [
                header ~title_id "SESSION" "New session" close ~busy;
                Vdom.Node.div
                  ~attrs:[ class_ "modal-surface-body" ]
                  [
                    Vdom.Node.div
                      ~attrs:[ class_ "fixed-workspace" ]
                      [
                        text "Workspace ";
                        Vdom.Node.strong [ text workspace.name ];
                        text (" / " ^ workspace.root);
                      ];
                    Vdom.Node.label
                      [
                        text "Session title";
                        Vdom.Node.input
                          ~attrs:
                            [
                              Vdom.Attr.id "session-title";
                              Vdom.Attr.create "maxlength" "120";
                              Vdom.Attr.value title;
                              Vdom.Attr.on_input (fun _ value ->
                                  set_title value);
                            ]
                          ();
                      ];
                    Vdom.Node.label
                      [
                        text "Harness";
                        Vdom.Node.select
                          ~attrs:
                            [
                              Vdom.Attr.create "aria-label" "Session harness";
                              Vdom.Attr.value
                                (Option.value_map harness ~default:""
                                   ~f:Control_plane.Session.harness_to_string);
                              Vdom.Attr.on_change (fun _ value ->
                                  set_harness
                                    (List.find harnesses ~f:(fun candidate ->
                                         String.equal value
                                           (Control_plane.Session
                                            .harness_to_string candidate))));
                            ]
                          (List.map harnesses ~f:(fun candidate ->
                               let value =
                                 Control_plane.Session.harness_to_string
                                   candidate
                               in
                               Vdom.Node.option
                                 ~attrs:
                                   ([ Vdom.Attr.value value ]
                                   @
                                   if
                                     Option.exists harness ~f:(fun selected ->
                                         String.equal value
                                           (Control_plane.Session
                                            .harness_to_string selected))
                                   then
                                     [ Vdom.Attr.create "selected" "selected" ]
                                   else [])
                                 [ text value ]));
                      ];
                    error_view;
                  ];
                footer ~close ~busy ~danger:false "START SESSION" "STARTING...";
              ];
          ]
    | Rename _ ->
        let title_id = "session-lifecycle-title" in
        Modal.surface ~kind:Dialog ~surface_id:"session-lifecycle-dialog"
          ~labelled_by:title_id ~class_name:"session-dialog"
          ~dismissible:(not busy) ~on_close:close
          [
            Vdom.Node.form
              ~attrs:
                [
                  Vdom.Attr.on_submit (fun _ ->
                      Effect.Many [ Vdom.Effect.Prevent_default; submit ]);
                ]
              [
                header ~title_id "SESSION" "Rename session" close ~busy;
                Vdom.Node.div
                  ~attrs:[ class_ "modal-surface-body" ]
                  [
                    Vdom.Node.label
                      [
                        text "Session title";
                        Vdom.Node.input
                          ~attrs:
                            [
                              Vdom.Attr.id "session-title";
                              Vdom.Attr.create "maxlength" "120";
                              Vdom.Attr.value title;
                              Vdom.Attr.on_input (fun _ value ->
                                  set_title value);
                            ]
                          ();
                      ];
                    error_view;
                  ];
                footer ~close ~busy ~danger:false "SAVE" "SAVING...";
              ];
          ]
    | Archive session ->
        let title_id = "session-lifecycle-title"
        and description_id = "archive-description" in
        Modal.surface ~kind:Alertdialog ~surface_id:"session-lifecycle-dialog"
          ~labelled_by:title_id ~described_by:description_id
          ~class_name:"archive-dialog" ~dismissible:(not busy) ~on_close:close
          [
            Vdom.Node.form
              ~attrs:
                [
                  Vdom.Attr.on_submit (fun _ ->
                      Effect.Many [ Vdom.Effect.Prevent_default; submit ]);
                ]
              [
                header ~title_id "SESSION" "Archive session?" close ~busy;
                Vdom.Node.div
                  ~attrs:[ class_ "modal-surface-body" ]
                  [
                    Vdom.Node.p
                      ~attrs:[ Vdom.Attr.id description_id ]
                      [
                        Vdom.Node.strong [ text session.title ];
                        text
                          " will stop running and leave the active session \
                           list. Its conversation remains on disk and can be \
                           restored.";
                      ];
                    error_view;
                  ];
                Vdom.Node.footer
                  ~attrs:[ class_ "modal-surface-footer" ]
                  [
                    Vdom.Node.button
                      ~attrs:
                        ([
                           Vdom.Attr.id "archive-cancel";
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
                           Vdom.Attr.create "type" "submit";
                         ]
                        @ if busy then [ Vdom.Attr.disabled ] else [])
                      [
                        text
                          (if busy then "ARCHIVING..." else "ARCHIVE SESSION");
                      ];
                  ];
              ];
          ]
  in
  { view; open_create; open_rename; open_archive }
