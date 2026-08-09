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

let message ~key ~class_name ~role ~status ?copy body =
  Vdom.Node.create "article" ~key
    ~attrs:[ class_ ("timeline-item " ^ class_name) ]
    [
      Vdom.Node.div
        ~attrs:[ class_ "message-meta" ]
        [
          Vdom.Node.strong ~attrs:[ class_ "message-role" ] [ text role ];
          Vdom.Node.span ~attrs:[ class_ "message-status" ] [ text status ];
          Option.value copy ~default:Vdom.Node.none;
        ];
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
           body)
  | Tool { sequence = _; tool_call_id; title; input; output; status; artifacts }
    ->
      let key = "tool:" ^ tool_call_id in
      let detail = Timeline_projection.tool_text ~input ~output ~artifacts in
      Some
        (Vdom.Node.create "article" ~key
           ~attrs:[ class_ "timeline-item timeline-tool" ]
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
                   [
                     Vdom.Node.p
                       ~attrs:[ class_ "message-status" ]
                       [ text tool_call_id ];
                     Vdom.Node.div
                       ~attrs:[ class_ "tool-copy-row" ]
                       [
                         copy_button ~key ~kind:"tool output" ~body:detail
                           ~copy_feedback ~on_copy;
                       ];
                     Vdom.Node.p
                       ~attrs:[ class_ "message-body" ]
                       [ text detail ];
                   ];
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
