open! Core
open! Bonsai_web.Cont

let class_ name = Vdom.Attr.class_ name
let text = Vdom.Node.text

let optional_text value =
  Option.value_map value ~default:Vdom.Node.none ~f:(fun value ->
      if String.is_empty value then Vdom.Node.none
      else Vdom.Node.p [ text value ])

let render index artifact =
  let key prefix = prefix ^ "-" ^ Int.to_string index in
  match artifact with
  | Acp_content.Diff { path; before; after } ->
      Vdom.Node.create "details" ~key:(key "diff")
        ~attrs:[ class_ "artifact-card artifact-diff" ]
        [
          Vdom.Node.create "summary"
            [ Vdom.Node.span [ text "File change" ]; Vdom.Node.b [ text path ] ];
          Vdom.Node.div
            ~attrs:[ class_ "artifact-diff-columns" ]
            [
              Vdom.Node.section
                [
                  Vdom.Node.span [ text "Before" ];
                  Vdom.Node.pre [ text before ];
                ];
              Vdom.Node.section
                [
                  Vdom.Node.span [ text "After" ]; Vdom.Node.pre [ text after ];
                ];
            ];
        ]
  | Terminal { terminal_id; text = detail } ->
      Vdom.Node.section ~key:(key "terminal")
        ~attrs:[ class_ "artifact-card artifact-terminal" ]
        [
          Vdom.Node.span [ text "Terminal" ];
          Vdom.Node.b [ text terminal_id ];
          optional_text detail;
        ]
  | Image image ->
      Vdom.Node.create "figure" ~key:(key "image")
        ~attrs:[ class_ "artifact-card artifact-image" ]
        [
          Vdom.Node.img
            ~attrs:
              [
                Vdom.Attr.src (Image_attachment.data_url image);
                Vdom.Attr.create "alt" (Image_attachment.name image);
              ]
            ();
          Vdom.Node.create "figcaption" [ text (Image_attachment.name image) ];
        ]
  | Resource { uri; name; text = detail } ->
      Vdom.Node.section ~key:(key "resource")
        ~attrs:[ class_ "artifact-card artifact-resource" ]
        [
          Vdom.Node.span [ text "Resource" ];
          Vdom.Node.b [ text uri ];
          optional_text
            (match (name, detail) with
            | Some name, Some detail when not (String.equal name detail) ->
                Some (name ^ "\n" ^ detail)
            | Some name, _ -> Some name
            | None, detail -> detail);
        ]
  | Location _ -> Vdom.Node.none

let location = function
  | Acp_content.Location { path; line; text = detail } ->
      let suffix =
        Option.value_map line ~default:"" ~f:(fun value ->
            " / line " ^ Int.to_string value)
        ^ Option.value_map detail ~default:"" ~f:(fun value -> " / " ^ value)
      in
      Some (Vdom.Node.span [ text (path ^ suffix) ])
  | Diff _ | Terminal _ | Image _ | Resource _ -> None

let render_all artifacts =
  let locations = List.filter_map artifacts ~f:location in
  (if List.is_empty locations then []
   else [ Vdom.Node.div ~attrs:[ class_ "artifact-locations" ] locations ])
  @ List.mapi artifacts ~f:render
