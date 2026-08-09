open! Core
open! Bonsai_web.Cont

let class_ name = Vdom.Attr.class_ name
let text = Vdom.Node.text

let decision_button ~disabled ~class_name ~label action =
  Vdom.Node.button
    ~attrs:
      ([
         class_ ("permission-button " ^ class_name);
         Vdom.Attr.create "type" "button";
         Vdom.Attr.on_click (fun _ -> action);
       ]
      @ if disabled then [ Vdom.Attr.create "disabled" "" ] else [])
    [ text label ]

let option_class kind =
  if String.is_prefix kind ~prefix:"reject" then "reject" else "allow"

let render_request ~deciding ~on_decide
    ({ sequence; request } : Event_history.pending_permission) =
  let tool = request.tool in
  let disabled = Set.mem deciding request.request_id in
  let detail =
    Option.value_map tool.raw_input
      ~default:"No structured tool input was supplied."
      ~f:Yojson.Safe.pretty_to_string
  in
  let option_buttons =
    List.map request.options ~f:(fun option ->
        decision_button ~disabled ~class_name:(option_class option.kind)
          ~label:option.name
          (on_decide ~request_id:request.request_id
             ~option_id:(Some option.option_id)))
  in
  Vdom.Node.create "article"
    ~key:(Int64.to_string sequence ^ "-permission")
    ~attrs:[ class_ "timeline-item timeline-permission" ]
    [
      Vdom.Node.div
        ~attrs:[ class_ "message-meta" ]
        [
          Vdom.Node.strong
            ~attrs:[ class_ "message-role" ]
            [ text "Permission required" ];
          Vdom.Node.span
            ~attrs:[ class_ "message-status" ]
            [ text (if disabled then "decision submitted" else tool.status) ];
        ];
      Vdom.Node.h3 ~attrs:[ class_ "permission-title" ] [ text tool.title ];
      Vdom.Node.dl
        ~attrs:[ class_ "permission-context" ]
        [
          Vdom.Node.div
            [
              Vdom.Node.dt [ text "Request" ];
              Vdom.Node.dd [ text request.request_id ];
            ];
          Vdom.Node.div
            [
              Vdom.Node.dt [ text "Tool" ];
              Vdom.Node.dd [ text tool.tool_call_id ];
            ];
          Vdom.Node.div
            [ Vdom.Node.dt [ text "Kind" ]; Vdom.Node.dd [ text tool.kind ] ];
        ];
      Vdom.Node.pre
        ~attrs:[ class_ "message-body permission-input" ]
        [ text detail ];
      Vdom.Node.div
        ~attrs:[ class_ "permission-actions" ]
        (option_buttons
        @ [
            decision_button ~disabled ~class_name:"cancel" ~label:"Cancel"
              (on_decide ~request_id:request.request_id ~option_id:None);
          ]);
    ]

let render_pending entries ~deciding ~on_decide =
  Event_history.pending_permissions entries
  |> List.map ~f:(render_request ~deciding ~on_decide)
