open! Core
open! Bonsai_web.Cont
open Bonsai.Let_syntax

let class_ name = [ Vdom.Attr.class_ name ]
let text = Vdom.Node.text

let selected_session state selected_id =
  match (state, selected_id) with
  | Session_rail.Loaded sessions, Some id ->
      List.find sessions ~f:(fun (session : Control_plane.Session.t) ->
          String.equal session.id id)
  | _ -> None

let render_header sessions selected_id =
  let status, status_class =
    match (sessions, selected_session sessions selected_id) with
    | Session_rail.Loading, _ -> ("loading", "running")
    | Failed _, _ -> ("offline", "offline")
    | Loaded [], _ -> ("idle", "idle")
    | Loaded _, Some session ->
        let status = Control_plane.Session.status_to_string session.status in
        (status, status)
    | Loaded _, None -> ("idle", "idle")
  in
  Vdom.Node.header ~attrs:(class_ "app-header")
    [
      Vdom.Node.div ~attrs:(class_ "brand-lockup")
        [
          Vdom.Node.span ~attrs:(class_ "brand-mark") [ text "P" ];
          Vdom.Node.div
            [
              Vdom.Node.h1 [ text "PISS" ];
              Vdom.Node.p ~attrs:(class_ "eyebrow")
                [ text "Durable agent workbench" ];
            ];
        ];
      Vdom.Node.div
        ~attrs:(class_ ("connection-pill connection-" ^ status_class))
        [ Vdom.Node.create "i" []; Vdom.Node.span [ text status ] ];
    ]

let history_request session_id =
  Browser_http.get
    ~query:[ ("recent", "500"); ("session", session_id) ]
    "/api/v2/events"

let set_history_from_response ~set_history session_id = function
  | Error error ->
      set_history (Timeline_view.Failed (session_id, Error.to_string_hum error))
  | Ok body -> (
      match Event_history.decode body with
      | Error message -> set_history (Failed (session_id, message))
      | Ok entries -> set_history (Loaded (session_id, entries)))

let load_history ~set_history session_id =
  Effect.bind (set_history (Timeline_view.Loading session_id)) ~f:(fun () ->
      Effect.bind
        (Effect.of_deferred_thunk (fun () -> history_request session_id))
        ~f:(set_history_from_response ~set_history session_id))

let rec poll_history ~set_history ~session_id ~command_id ~remaining =
  Effect.bind
    (Effect.of_deferred_thunk (fun () -> history_request session_id))
    ~f:(function
      | Error _ as response ->
          set_history_from_response ~set_history session_id response
      | Ok body -> (
          match Event_history.decode body with
          | Error message -> set_history (Failed (session_id, message))
          | Ok entries ->
              Effect.bind
                (set_history (Loaded (session_id, entries)))
                ~f:(fun () ->
                  if
                    remaining <= 0
                    || Event_history.command_is_terminal ~command_id entries
                  then Effect.Ignore
                  else
                    (* TODO(tracer): Replace bounded post-submit polling with
                       the event stream when the next session slice adds SSE. *)
                    Effect.bind
                      (Effect.of_deferred_thunk (fun () -> Async_js.sleep 0.5))
                      ~f:(fun () ->
                        poll_history ~set_history ~session_id ~command_id
                          ~remaining:(remaining - 1)))))

let component graph =
  let sessions, set_sessions = Bonsai.state Session_rail.Loading graph in
  let selected_id, set_selected_id = Bonsai.state None graph in
  let history, set_history =
    Bonsai.state Timeline_view.Sessions_loading graph
  in
  let prompt, set_prompt = Bonsai.state "" graph in
  let submitting, set_submitting = Bonsai.state false graph in
  let notice, set_notice = Bonsai.state "" graph in
  let load =
    let%arr set_sessions = set_sessions
    and set_selected_id = set_selected_id
    and set_history = set_history in
    Effect.bind
      (Effect.of_deferred_thunk (fun () -> Browser_http.get "/api/v2/sessions"))
      ~f:(function
        | Error error -> set_sessions (Failed (Error.to_string_hum error))
        | Ok body -> (
            match Control_plane.decode_sessions body with
            | Error message -> set_sessions (Failed message)
            | Ok sessions ->
                Effect.bind (set_sessions (Loaded sessions)) ~f:(fun () ->
                    match sessions with
                    | [] -> Effect.Ignore
                    | session :: _ ->
                        Effect.bind (set_selected_id (Some session.id))
                          ~f:(fun () -> load_history ~set_history session.id))))
  in
  Bonsai.Edge.lifecycle ~on_activate:load graph;
  let%arr sessions = sessions
  and selected_id = selected_id
  and history = history
  and prompt = prompt
  and submitting = submitting
  and notice = notice
  and set_selected_id = set_selected_id
  and set_history = set_history
  and set_prompt = set_prompt
  and set_submitting = set_submitting
  and set_notice = set_notice in
  let session = selected_session sessions selected_id in
  let visible_history =
    match sessions with
    | Session_rail.Loading -> Timeline_view.Sessions_loading
    | Failed message -> Sessions_failed message
    | Loaded [] -> No_sessions
    | Loaded (_ :: _) -> history
  in
  let select id =
    Effect.bind (set_selected_id (Some id)) ~f:(fun () ->
        Effect.Many
          [ set_prompt ""; set_notice ""; load_history ~set_history id ])
  in
  let submit () =
    match (session, submitting) with
    | None, _ | _, true -> Effect.Ignore
    | Some session, false -> (
        let command_id = Command_id.create () in
        match Prompt_command.prompt ~command_id ~text:prompt with
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
                        Effect.Many
                          [
                            set_prompt "";
                            set_submitting false;
                            set_notice "Prompt accepted. Refreshing history...";
                            poll_history ~set_history ~session_id:session.id
                              ~command_id:(Prompt_command.command_id command)
                              ~remaining:20;
                          ])))
  in
  Vdom.Node.main ~attrs:(class_ "control-room")
    [
      render_header sessions selected_id;
      Vdom.Node.section ~attrs:(class_ "workspace-grid")
        [
          Session_rail.render sessions ~selected_id ~on_select:select;
          Timeline_view.render ~session ~state:visible_history ~prompt
            ~submitting ~notice ~on_prompt:set_prompt ~on_submit:submit;
        ];
    ]

let () = Bonsai_web.Start.start component
