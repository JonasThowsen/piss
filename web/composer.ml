open! Core
open! Bonsai_web.Cont
open Bonsai.Let_syntax
open Composer_ui

type output = {
  view : Vdom.Node.t;
  restore : string option -> unit Effect.t;
  set_notice : string -> unit Effect.t;
  submit_review_notes : Prompt_command.action -> string -> unit Effect.t;
  has_pending : unit -> bool;
}

type pending_submission = { session_id : string; command : Prompt_command.t }

let class_ name = Vdom.Attr.class_ name
let text = Vdom.Node.text

let component session runtime connecting stream_notice notice config_controls
    ~set_notice ~on_busy ~refresh_runtime graph =
  let submission_locked = ref false in
  let request_in_flight = ref false in
  let prompt_state, set_prompt_state = Bonsai.state (None, "") graph in
  let session_id =
    let%arr session = session in
    Option.map session ~f:(fun (session : Control_plane.Session.t) ->
        session.id)
  in
  let prompt =
    let%arr session_id = session_id
    and prompt_session_id, prompt = prompt_state in
    if Option.equal String.equal prompt_session_id session_id then prompt
    else
      Option.bind session_id ~f:Composer_draft.read |> Option.value ~default:""
  in
  let set_prompt =
    let%arr session_id = session_id and set_prompt_state = set_prompt_state in
    fun prompt -> set_prompt_state (session_id, prompt)
  in
  let resources, set_resources = Bonsai.state [] graph in
  let picker, set_picker = Bonsai.state Mention_picker.Closed graph in
  let command_active, set_command_active = Bonsai.state None graph in
  let command_selected, set_command_selected = Bonsai.state 0 graph in
  let submission, set_submission =
    Bonsai.state Prompt_command.Submission.ready graph
  in
  let delivery, set_delivery = Bonsai.state Prompt_command.Prompt graph in
  let cancel_sequence, set_cancel_sequence = Bonsai.state None graph in
  let runtime_status =
    let%arr runtime = runtime in
    Option.map runtime ~f:(fun runtime -> runtime.Runtime_domain.status)
  in
  let reset_run_state =
    let%arr set_delivery = set_delivery
    and set_cancel_sequence = set_cancel_sequence in
    function
    | Some Runtime_domain.Running -> Effect.Ignore
    | _ ->
        Effect.Many
          [ set_delivery Prompt_command.Prompt; set_cancel_sequence None ]
  in
  Bonsai.Edge.on_change runtime_status ~equal:(Option.equal phys_equal)
    ~callback:reset_run_state graph;
  let attachment_available =
    let%arr session = session
    and runtime = runtime
    and connecting = connecting
    and submission = submission in
    Option.is_some session && (not connecting)
    && Option.is_none (Prompt_command.Submission.pending submission)
    && Option.value_map runtime ~default:false
         ~f:(fun (runtime : Runtime_domain.t) ->
           runtime.accepts_images
           &&
           match runtime.status with
           | Idle | Waiting | Running -> true
           | _ -> false)
  in
  let attachments =
    Image_attachments.component ~available:attachment_available
      ~on_notice:set_notice ~on_processing:on_busy graph
  in
  let reset_session_state =
    let%arr set_prompt_state = set_prompt_state
    and set_resources = set_resources
    and set_picker = set_picker
    and set_command_active = set_command_active
    and set_command_selected = set_command_selected
    and attachments = attachments in
    fun session_id ->
      let prompt =
        Option.bind session_id ~f:Composer_draft.read
        |> Option.value ~default:""
      in
      Effect.Many
        [
          set_prompt_state (session_id, prompt);
          set_resources [];
          set_picker Mention_picker.Closed;
          set_command_active None;
          set_command_selected 0;
          attachments.clear ();
        ]
  in
  let%arr session = session
  and runtime = runtime
  and connecting = connecting
  and stream_notice = stream_notice
  and config_controls = config_controls
  and attachments = attachments
  and prompt = prompt
  and resources = resources
  and picker = picker
  and command_active = command_active
  and command_selected = command_selected
  and submission = submission
  and delivery = delivery
  and cancel_sequence = cancel_sequence
  and notice = notice
  and set_prompt = set_prompt
  and set_resources = set_resources
  and set_picker = set_picker
  and set_command_active = set_command_active
  and set_command_selected = set_command_selected
  and set_submission = set_submission
  and set_delivery = set_delivery
  and set_cancel_sequence = set_cancel_sequence
  and reset_session_state = reset_session_state
  and on_busy = on_busy
  and refresh_runtime = refresh_runtime
  and set_notice = set_notice in
  let submitting = Prompt_command.Submission.is_sending submission in
  let pending = Prompt_command.Submission.pending submission in
  let policy =
    Composer_policy.derive ~has_session:(Option.is_some session) ~runtime
      ~connecting
      ~submitting:(submitting || Option.is_some pending)
      ~image_processing:attachments.processing
  in
  let disabled = Composer_policy.disabled policy in
  let available_commands =
    Option.value_map runtime ~default:[] ~f:(fun runtime ->
        runtime.Runtime_domain.available_commands)
  in
  let command_matches =
    Option.value_map command_active ~default:[] ~f:(fun active ->
        Command_picker.matching_commands ~query:active.Command_picker.query
          available_commands)
  in
  let command_name_is_exact =
    Option.exists command_active ~f:(fun active ->
        List.exists available_commands ~f:(fun command ->
            String.equal active.Command_picker.query command.name))
  in
  let action_selected =
    match runtime with
    | Some runtime when phys_equal runtime.status Running ->
        not (phys_equal delivery Prompt_command.Prompt)
    | _ -> true
  in
  let close_picker () =
    Mention_request.cancel ();
    set_picker Mention_picker.Closed
  in
  let close_command_picker () =
    Effect.Many [ set_command_active None; set_command_selected 0 ]
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
  let persist_prompt value =
    Option.iter session ~f:(fun (session : Control_plane.Session.t) ->
        Composer_draft.write session.id value)
  in
  let update_prompt event value =
    persist_prompt value;
    let cursor, _ = event_selection event (String.length value) in
    match Command_picker.active_at_cursor ~text:value ~cursor with
    | Some active ->
        Effect.Many
          [
            set_prompt value;
            close_picker ();
            set_command_active (Some active);
            set_command_selected 0;
          ]
    | None -> (
        match Mention_picker.active_at_cursor ~text:value ~cursor with
        | None ->
            Effect.Many
              [ set_prompt value; close_picker (); close_command_picker () ]
        | Some active ->
            Effect.Many
              [ set_prompt value; close_command_picker (); start_search active ]
        )
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
        persist_prompt insertion.text;
        apply_to_field insertion;
        Effect.Many
          [
            set_prompt insertion.text;
            set_resources (Mention_picker.add_resource resources resource);
            set_picker Mention_picker.Closed;
          ]
  in
  let choose_command active command =
    let live_text, cursor, _ = field_snapshot prompt in
    let active =
      Command_picker.active_at_cursor ~text:live_text ~cursor
      |> Option.value ~default:active
    in
    match Command_picker.insert_command ~text:live_text ~active command with
    | None -> close_command_picker ()
    | Some insertion ->
        persist_prompt insertion.text;
        apply_to_field
          { Mention_picker.text = insertion.text; cursor = insertion.cursor };
        Effect.Many
          [
            set_prompt insertion.text;
            close_command_picker ();
            set_picker Mention_picker.Closed;
          ]
  in
  let send_pending ({ session_id; command } as pending) =
    Effect.bind
      (Effect.of_deferred_thunk (fun () ->
           Browser_http.post_json_typed
             ~query:[ ("session", session_id) ]
             "/api/v2/commands"
             (Prompt_command.to_yojson command)))
      ~f:(function
        | Error error when Browser_http.is_stale_runtime_conflict error ->
            request_in_flight := false;
            Effect.Many
              [
                set_submission
                  (Prompt_command.Submission.mark_uncertain
                     (Prompt_command.Submission.start pending));
                on_busy false;
                set_delivery Prompt_command.Prompt;
                refresh_runtime;
                set_notice
                  ("Runtime conflict: "
                  ^ Browser_http.error_message error
                  ^ " The runtime is refreshing; retry the same command.");
              ]
        | Error error when Browser_http.is_conflict error ->
            request_in_flight := false;
            submission_locked := false;
            Effect.Many
              [
                set_submission Prompt_command.Submission.ready;
                on_busy false;
                set_delivery
                  (Composer_policy.delivery_after_runtime_conflict ~conflict:true
                     ~delivery);
                refresh_runtime;
                set_notice
                  ("Runtime conflict: "
                  ^ Browser_http.error_message error
                  ^ " The runtime is refreshing; send as a normal prompt.");
              ]
        | Error error when Browser_http.is_authoritative_terminal error ->
            request_in_flight := false;
            submission_locked := false;
            Effect.Many
              [
                set_submission Prompt_command.Submission.ready;
                on_busy false;
                set_notice
                  ("Command rejected: " ^ Browser_http.error_message error);
              ]
        | Error error ->
            request_in_flight := false;
            Effect.Many
              [
                set_submission
                  (Prompt_command.Submission.mark_uncertain
                     (Prompt_command.Submission.start pending));
                set_notice
                  (Browser_http.error_message error
                  ^ " The response is uncertain; retry the same command or "
                  ^ "abandon it explicitly.");
              ]
        | Ok _ ->
            request_in_flight := false;
            submission_locked := false;
            Composer_draft.remove pending.session_id;
            Mention_request.cancel ();
            apply_to_field { text = ""; cursor = 0 };
            Effect.Many
              [
                set_prompt "";
                set_resources [];
                set_picker Mention_picker.Closed;
                set_command_active None;
                set_command_selected 0;
                attachments.clear ();
                set_delivery Prompt_command.Prompt;
                set_cancel_sequence None;
                set_submission Prompt_command.Submission.ready;
                on_busy false;
                set_notice
                  (match Prompt_command.action command with
                  | Prompt -> "Prompt accepted. Waiting for live events."
                  | Steer -> "Steer queued. Waiting for live events."
                  | Follow_up -> "Follow-up queued. Waiting for live events.");
              ])
  in
  let submit ?text_override requested_action =
    match (session, runtime, disabled, pending) with
    | _, _, _, _ when !submission_locked -> Effect.Ignore
    | None, _, _, _ | _, None, _, _ | _, _, true, _ | _, _, _, Some _ ->
        Effect.Ignore
    | _, Some runtime, false, None
      when phys_equal runtime.Runtime_domain.status Running
           && phys_equal requested_action Prompt_command.Prompt ->
        set_notice "Choose Steer next or Follow-up for the active run"
    | Some (session : Control_plane.Session.t), Some runtime, false, None -> (
        submission_locked := true;
        request_in_flight := true;
        let live_text, _, _ =
          Option.value_map text_override ~default:(field_snapshot prompt)
            ~f:(fun text -> (text, 0, 0))
        in
        let selected = Mention_picker.reconcile ~text:live_text resources in
        let command_resources =
          List.map selected ~f:(fun resource : Prompt_command.resource ->
              { path = resource.path })
        in
        let command_images =
          List.map attachments.images ~f:(fun image : Prompt_command.image ->
              {
                mime_type = Image_attachment.mime_type image;
                data = Image_attachment.data image;
                name = Image_attachment.name image;
              })
        in
        let action =
          Composer_policy.delivery_for_runtime runtime.status
            ~delivery:requested_action
        in
        let command_id = Command_id.create () in
        match
          Prompt_command.create ~runtime ~action ~command_id ~text:live_text
            ~images:command_images ~resources:command_resources
        with
        | Error message ->
            request_in_flight := false;
            submission_locked := false;
            set_notice message
        | Ok command ->
            let pending = { session_id = session.id; command } in
            Effect.bind (Timeline_scroll.jump_to_latest ()) ~f:(fun () ->
                Effect.bind
                  (Effect.Many
                     [
                       set_submission (Prompt_command.Submission.start pending);
                       on_busy true;
                     ])
                  ~f:(fun () -> send_pending pending)))
  in
  let retry () =
    match (submission, runtime, connecting) with
    | Prompt_command.Submission.Uncertain _, _, _ when !request_in_flight ->
        Effect.Ignore
    | Prompt_command.Submission.Uncertain _, _, true ->
        set_notice "Waiting for the current runtime before retrying."
    | Prompt_command.Submission.Uncertain pending, Some runtime, false
      when String.equal pending.session_id runtime.Runtime_domain.session_id ->
        request_in_flight := true;
        let pending =
          {
            pending with
            command = Prompt_command.retarget pending.command ~runtime;
          }
        in
        Effect.bind
          (Effect.Many
             [
               set_submission (Prompt_command.Submission.retry submission);
               on_busy true;
             ])
          ~f:(fun () -> send_pending pending)
    | Prompt_command.Submission.Uncertain _, Some _, false ->
        set_notice
          "Return to the command's original session before retrying or abandon \
           it."
    | Prompt_command.Submission.Uncertain _, None, false ->
        Effect.Many
          [
            refresh_runtime;
            set_notice "Waiting for the current runtime before retrying.";
          ]
    | ( (Prompt_command.Submission.Ready | Prompt_command.Submission.Sending _),
        _,
        _ ) ->
        Effect.Ignore
  in
  let abandon () =
    match pending with
    | None -> Effect.Ignore
    | Some _ when !request_in_flight -> Effect.Ignore
    | Some _ ->
        submission_locked := false;
        Effect.Many
          [
            set_submission (Prompt_command.Submission.abandon submission);
            on_busy false;
            set_notice
              ("Command abandoned. The draft is unchanged; submitting again "
             ^ "will create a new command identity.");
          ]
  in
  let keydown event =
    match (key event, command_active, picker) with
    | "ArrowDown", Some active, _ when not (List.is_empty command_matches) ->
        focus_at active.stop;
        let next = (command_selected + 1) mod List.length command_matches in
        prevent (set_command_selected next)
    | "ArrowUp", Some active, _ when not (List.is_empty command_matches) ->
        focus_at active.stop;
        let next =
          (command_selected - 1 + List.length command_matches)
          mod List.length command_matches
        in
        prevent (set_command_selected next)
    | "Escape", Some active, _ ->
        focus_at active.stop;
        prevent (close_command_picker ())
    | "Enter", Some active, _
      when (not command_name_is_exact) && not (List.is_empty command_matches)
      -> (
        match List.nth command_matches command_selected with
        | Some command -> prevent (choose_command active command)
        | None -> prevent Effect.Ignore)
    | "Enter", Some _, _
      when (not (event_bool event "isComposing"))
           && ((not (is_mobile ()))
              || event_bool event "ctrlKey" || event_bool event "metaKey")
           && not (event_bool event "shiftKey") ->
        prevent (submit delivery)
    | "ArrowDown", None, Open { active; _ } ->
        focus_at active.stop;
        prevent (set_picker (Mention_picker.move picker 1))
    | "ArrowUp", None, Open { active; _ } ->
        focus_at active.stop;
        prevent (set_picker (Mention_picker.move picker (-1)))
    | "Escape", None, Open { active; _ } ->
        focus_at active.stop;
        prevent (close_picker ())
    | "Enter", None, Open { active; availability = Ready (_ :: _); _ } -> (
        match Mention_picker.selected_resource picker with
        | Some resource -> prevent (choose active resource)
        | None -> prevent Effect.Ignore)
    | "Enter", None, Open _ -> prevent Effect.Ignore
    | "Enter", None, Closed
      when (not (event_bool event "isComposing"))
           && ((not (is_mobile ()))
              || event_bool event "ctrlKey" || event_bool event "metaKey")
           && not (event_bool event "shiftKey") ->
        prevent (submit delivery)
    | _ -> Effect.Ignore
  in
  let cancel () =
    match (session, runtime) with
    | Some session, Some runtime
      when phys_equal runtime.Runtime_domain.status Running
           && Option.is_none cancel_sequence ->
        Effect.bind (set_cancel_sequence (Some runtime.last_sequence))
          ~f:(fun () ->
            Effect.bind
              (Effect.of_deferred_thunk (fun () ->
                   Browser_http.post_json
                     ~query:[ ("session", session.id) ]
                     "/api/v2/cancel"
                     (Runtime_domain.mutation_to_yojson runtime
                        ~mutation_id:(Command_id.create ()) [])))
              ~f:(function
                | Error error ->
                    Effect.Many
                      [
                        set_cancel_sequence None;
                        set_notice (Error.to_string_hum error);
                      ]
                | Ok _ ->
                    set_notice
                      "Cancellation requested. Waiting for session events."))
    | _ -> Effect.Ignore
  in
  let combined_notice =
    if String.is_empty stream_notice then notice
    else if String.is_empty notice then stream_notice
    else notice ^ " " ^ stream_notice
  in
  let active_descendant =
    match command_active with
    | Some _ when not (List.is_empty command_matches) ->
        Some (Printf.sprintf "slash-command-%d" command_selected)
    | Some _ -> None
    | None -> (
        match picker with
        | Open { availability = Ready (_ :: _); selected; _ } ->
            Some (Printf.sprintf "file-mention-%d" selected)
        | _ -> None)
  in
  let picker_open =
    Option.is_some command_active
    || match picker with Mention_picker.Closed -> false | Open _ -> true
  in
  let picker_controls =
    if Option.is_some command_active then "slash-command-options"
    else "file-mention-options"
  in
  let on_choose resource =
    match picker with
    | Open { active; _ } -> choose active resource
    | Closed -> Effect.Ignore
  in
  let on_choose_command command =
    Option.value_map command_active ~default:Effect.Ignore ~f:(fun active ->
        choose_command active command)
  in
  let view =
    Vdom.Node.div
      ~attrs:[ class_ "composer-wrap" ]
      [
        Vdom.Node.p
          ~attrs:
            [
              class_ "notice";
              Vdom.Attr.create "role" "status";
              Vdom.Attr.create "aria-live" "polite";
            ]
          [ text combined_notice ];
        Vdom.Node.form
          ~attrs:
            [
              class_ "composer";
              Vdom.Attr.on_submit (fun _ -> prevent (submit delivery));
            ]
          [
            Vdom.Node.textarea
              ~attrs:
                ([
                   Vdom.Attr.id input_id;
                   Vdom.Attr.create "aria-label" "Message agent";
                   Vdom.Attr.create "aria-autocomplete" "list";
                   Vdom.Attr.create "aria-controls" picker_controls;
                   Vdom.Attr.create "aria-expanded" (Bool.to_string picker_open);
                   Vdom.Attr.placeholder (Composer_policy.placeholder policy);
                   Vdom.Attr.create "maxlength" "65536";
                   Vdom.Attr.value_prop prompt;
                   Vdom.Attr.on_input update_prompt;
                   Vdom.Attr.on_keydown keydown;
                   attachments.paste_attr;
                 ]
                @
                if disabled then [ Vdom.Attr.disabled ]
                else
                  []
                  @ Option.value_map active_descendant ~default:[] ~f:(fun id ->
                      [ Vdom.Attr.create "aria-activedescendant" id ]))
              [];
            command_picker_view command_active command_matches
              ~selected:command_selected ~on_hover:set_command_selected
              ~on_choose:on_choose_command;
            picker_view picker
              ~on_hover:(fun index ->
                set_picker (Mention_picker.select_index picker index))
              ~on_choose;
            attachments.previews;
            (match submission with
            | Prompt_command.Submission.Uncertain _ ->
                Vdom.Node.div
                  ~attrs:
                    [
                      class_ "composer-retry-actions";
                      Vdom.Attr.create "role" "group";
                      Vdom.Attr.create "aria-label" "Uncertain command delivery";
                    ]
                  [
                    Vdom.Node.button
                      ~attrs:
                        [
                          Vdom.Attr.create "type" "button";
                          Vdom.Attr.on_click (fun _ -> retry ());
                        ]
                      [ text "Retry same command" ];
                    Vdom.Node.button
                      ~attrs:
                        [
                          class_ "abandon-command";
                          Vdom.Attr.create "type" "button";
                          Vdom.Attr.on_click (fun _ -> abandon ());
                        ]
                      [ text "Abandon command" ];
                  ]
            | Prompt_command.Submission.Ready
            | Prompt_command.Submission.Sending _ ->
                Vdom.Node.none);
            Vdom.Node.div
              ~attrs:[ class_ "composer-footer" ]
              [
                Vdom.Node.div
                  ~attrs:[ class_ "composer-insertions" ]
                  [ attachments.view ];
                config_controls;
                Vdom.Node.button
                  ~attrs:
                    ([
                       class_ "send-action";
                       Vdom.Attr.create "type" "submit";
                       Vdom.Attr.create "aria-label" "Send message";
                     ]
                    @
                    if
                      disabled || (not action_selected)
                      || String.is_empty (String.strip prompt)
                         && List.is_empty attachments.images
                    then [ Vdom.Attr.create "disabled" "" ]
                    else [])
                  [
                    text
                      (if submitting || attachments.processing then "..."
                       else ">");
                  ];
              ];
            (match runtime with
            | Some runtime when phys_equal runtime.status Running ->
                Vdom.Node.div
                  ~attrs:[ class_ "composer-run-actions" ]
                  [
                    Vdom.Node.button
                      ~attrs:
                        [
                          Vdom.Attr.create "type" "button";
                          Vdom.Attr.create "aria-pressed"
                            (Bool.to_string (phys_equal delivery Steer));
                          (if phys_equal delivery Steer then class_ "active"
                           else class_ "");
                          Vdom.Attr.on_click (fun _ -> set_delivery Steer);
                        ]
                      [ text "Steer next" ];
                    Vdom.Node.button
                      ~attrs:
                        [
                          Vdom.Attr.create "type" "button";
                          Vdom.Attr.create "aria-pressed"
                            (Bool.to_string (phys_equal delivery Follow_up));
                          (if phys_equal delivery Follow_up then class_ "active"
                           else class_ "");
                          Vdom.Attr.on_click (fun _ -> set_delivery Follow_up);
                        ]
                      [ text "Follow-up" ];
                    Vdom.Node.button
                      ~attrs:
                        ([
                           class_ "cancel-run";
                           Vdom.Attr.create "type" "button";
                           Vdom.Attr.on_click (fun _ -> cancel ());
                         ]
                        @
                        if Option.is_some cancel_sequence then
                          [ Vdom.Attr.disabled ]
                        else [])
                      [
                        text
                          (if Option.is_some cancel_sequence then
                             "Cancelling..."
                           else "Cancel");
                      ];
                  ]
            | _ -> Vdom.Node.none);
          ];
      ]
  in
  {
    view;
    restore =
      (fun session_id ->
        if Option.is_none pending then (
          submission_locked := false;
          request_in_flight := false);
        Mention_request.cancel ();
        Effect.Many
          [
            reset_session_state session_id;
            set_delivery Prompt_command.Prompt;
            set_cancel_sequence None;
            set_notice "";
          ]);
    set_notice;
    submit_review_notes = (fun action text -> submit ~text_override:text action);
    has_pending = (fun () -> !submission_locked || Option.is_some pending);
  }
