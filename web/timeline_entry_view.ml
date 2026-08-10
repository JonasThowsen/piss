open! Core
open! Bonsai_web.Cont

let class_ name = Vdom.Attr.class_ name
let text = Vdom.Node.text

let empty_state glyph title message =
  Vdom.Node.div
    ~attrs:[ class_ "empty-state" ]
    [
      Vdom.Node.span [ text glyph ];
      Vdom.Node.h3 [ text title ];
      Vdom.Node.p [ text message ];
    ]

let copy_button ~key ~kind ~body ~copy_feedback ~on_copy =
  let state =
    match copy_feedback with
    | Some (candidate, status) when String.equal candidate key -> Some status
    | _ -> None
  in
  let adjective, class_name =
    match state with
    | None -> ("Copy", "")
    | Some Clipboard.Copied -> ("Copied", " copied")
    | Some Failed -> ("Copy failed", " failed")
  in
  Vdom.Node.button
    ~attrs:
      [
        class_ ("timeline-copy" ^ class_name);
        Vdom.Attr.create "type" "button";
        Vdom.Attr.create "aria-label" (adjective ^ " " ^ kind);
        Vdom.Attr.on_click (fun _ -> on_copy ~key ~text:body);
      ]
    [ Vdom.Node.b [ text (String.uppercase adjective) ] ]

let message ~key ~class_name ~role ~status ?copy ?body_node body =
  Vdom.Node.create "article" ~key
    ~attrs:
      [
        class_ ("timeline-item " ^ class_name);
        Vdom.Attr.create "data-timeline-key" key;
      ]
    [
      Vdom.Node.div
        ~attrs:[ class_ "message-meta" ]
        [
          Vdom.Node.strong ~attrs:[ class_ "message-role" ] [ text role ];
          Vdom.Node.span ~attrs:[ class_ "message-status" ] [ text status ];
          Option.value copy ~default:Vdom.Node.none;
        ];
      Option.value body_node
        ~default:
          (if String.is_empty body then Vdom.Node.none
           else Vdom.Node.p ~attrs:[ class_ "message-body" ] [ text body ]);
    ]

let render ~copy_feedback ~on_copy = function
  | Event_history.User { sequence; command_id; text = body } ->
      Some
        (message
           ~key:(Int64.to_string sequence ^ "-user")
           ~class_name:"timeline-user" ~role:"You" ~status:command_id body)
  | Agent { sequence = _; message_id; text = body } ->
      let key = "agent:" ^ message_id in
      Some
        (message ~key ~class_name:"timeline-agent" ~role:"Agent"
           ~status:message_id
           ~copy:
             (copy_button ~key ~kind:"message" ~body ~copy_feedback ~on_copy)
           ~body_node:
             (Markdown_view.render ~item_key:key ~copy_feedback ~on_copy body)
           body)
  | Tool { sequence = _; tool_call_id; title; input; output; status; artifacts }
    ->
      let key = "tool:" ^ tool_call_id in
      let detail = Timeline_projection.tool_text ~input ~output ~artifacts in
      Some
        (Vdom.Node.create "article" ~key
           ~attrs:
             [
               class_ "timeline-item timeline-tool";
               Vdom.Attr.create "data-timeline-key" key;
             ]
           [
             Vdom.Node.create "details"
               ~attrs:[ class_ "tool-disclosure" ]
               [
                 Vdom.Node.create "summary"
                   [
                     Vdom.Node.span
                       ~attrs:[ class_ "tool-disclosure-icon" ]
                       [ text ">" ];
                     Vdom.Node.strong
                       ~attrs:[ class_ "message-role" ]
                       [ text title ];
                     Vdom.Node.span
                       ~attrs:[ class_ "message-status" ]
                       [ text status ];
                   ];
                 Vdom.Node.div
                   ~attrs:[ class_ "timeline-contents" ]
                   ([
                      Vdom.Node.p
                        ~attrs:[ class_ "message-status" ]
                        [ text tool_call_id ];
                      Vdom.Node.div
                        ~attrs:[ class_ "tool-copy-row" ]
                        [
                          copy_button ~key ~kind:"tool output" ~body:detail
                            ~copy_feedback ~on_copy;
                        ];
                      Vdom.Node.pre
                        ~attrs:[ class_ "message-body" ]
                        [ text detail ];
                    ]
                   @ Artifact_view.render_all artifacts);
               ];
           ])
  | Command_state { sequence; command_id; state } ->
      let state = Event_history.command_state_to_string state in
      Some
        (message
           ~key:(Int64.to_string sequence ^ "-command")
           ~class_name:"timeline-command" ~role:"Command"
           ~status:("state / " ^ state) command_id)
  | Permission_requested _ | Permission_resolved _ | Permission_cancelled _ ->
      None

let activity_chevron () =
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
      Vdom.Node.create_svg "path"
        ~attrs:[ Vdom.Attr.create "d" "m9 18 6-6-6-6" ]
        [];
    ]

let running_status status =
  List.mem [ "pending"; "in_progress"; "running" ] status ~equal:String.equal

let count_label count singular =
  Int.to_string count ^ " " ^ if count = 1 then singular else singular ^ "s"

let activity ~copy_feedback ~on_copy ~key ~sequence entries =
  let tools =
    List.filter_map entries ~f:(function
      | Event_history.Tool { title; status; _ } -> Some (title, status)
      | User _ | Agent _ | Command_state _ | Permission_requested _
      | Permission_resolved _ | Permission_cancelled _ ->
          None)
  in
  let command_count =
    List.count entries ~f:(function Command_state _ -> true | _ -> false)
  in
  let live_tool =
    List.find (List.rev tools) ~f:(fun (_, status) -> running_status status)
  in
  let title =
    match (live_tool, tools) with
    | Some (title, _), _ -> title
    | None, [ (title, _) ] -> title
    | None, [] -> "Command activity"
    | None, _ :: _ -> "Tool activity"
  in
  let counts =
    [ (List.length tools, "tool"); (command_count, "command update") ]
    |> List.filter_map ~f:(fun (count, singular) ->
        if count = 0 then None else Some (count_label count singular))
    |> String.concat ~sep:" · "
  in
  let status =
    Option.value_map live_tool ~default:counts ~f:(fun (_, tool_status) ->
        let status =
          tool_status
          |> String.tr ~target:'_' ~replacement:' '
          |> String.capitalize
        in
        if String.is_empty counts then status else status ^ " · " ^ counts)
  in
  Vdom.Node.create "details" ~key
    ~attrs:
      [
        class_
          ("timeline-item timeline-activity"
          ^ if Option.is_some live_tool then " timeline-activity-live" else "");
        Vdom.Attr.create "data-timeline-key" key;
        Vdom.Attr.create "data-timeline-sequence" (Int64.to_string sequence);
      ]
    [
      Vdom.Node.create "summary"
        [
          Vdom.Node.span
            ~attrs:[ class_ "activity-chevron" ]
            [ activity_chevron () ];
          Vdom.Node.span
            ~attrs:[ class_ "activity-summary-copy" ]
            [
              Vdom.Node.strong ~attrs:[ class_ "activity-title" ] [ text title ];
              Vdom.Node.span ~attrs:[ class_ "activity-meta" ] [ text status ];
            ];
          Option.value_map live_tool ~default:Vdom.Node.none ~f:(fun _ ->
              Vdom.Node.span
                ~attrs:[ class_ "activity-live-badge" ]
                [ Vdom.Node.create "i" []; text "LIVE" ]);
        ];
      Vdom.Node.div
        ~attrs:[ class_ "activity-entries" ]
        (List.filter_map entries ~f:(render ~copy_feedback ~on_copy));
    ]

let render_timeline ~copy_feedback ~on_copy entries =
  Timeline_projection.group_timeline entries
  |> List.filter_map ~f:(function
    | Message_entry entry -> render ~copy_feedback ~on_copy entry
    | Activity_group { key; sequence; entries } ->
        Some (activity ~copy_feedback ~on_copy ~key ~sequence entries))
