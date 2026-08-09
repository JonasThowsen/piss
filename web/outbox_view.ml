open! Core
open! Bonsai_web.Cont

let class_ name = Vdom.Attr.class_ name
let text = Vdom.Node.text

let render events =
  let outbox =
    events
    |> List.filter_map ~f:Event_history.outbox_update
    |> Outbox_projection.project
  in
  if List.is_empty outbox then Vdom.Node.none
  else
    Vdom.Node.section
      ~attrs:
        [
          class_ "outbox-tray";
          Vdom.Attr.create "aria-label" "Outgoing messages";
          Vdom.Attr.create "aria-live" "polite";
        ]
      (Vdom.Node.header
         [
           Vdom.Node.span [ text "Outgoing queue" ];
           Vdom.Node.b [ text (Int.to_string (List.length outbox)) ];
         ]
      :: List.map outbox ~f:(fun item ->
          let action =
            match item.Outbox_projection.action with
            | Prompt -> "Prompt"
            | Steer -> "Steer next"
            | Follow_up -> "Follow-up"
          in
          let status = Outbox_projection.status_to_string item.status in
          Vdom.Node.create "article" ~key:item.command_id
            ~attrs:[ class_ ("outbox-message " ^ status) ]
            [
              Vdom.Node.create "i" [];
              Vdom.Node.div
                [
                  Vdom.Node.header
                    [
                      Vdom.Node.b [ text action ];
                      Vdom.Node.small [ text status ];
                    ];
                  Vdom.Node.p
                    [
                      text
                        (if String.is_empty item.text then "Image attachment"
                         else item.text);
                    ];
                ];
            ]))
