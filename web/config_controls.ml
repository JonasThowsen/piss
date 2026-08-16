open! Core
open! Bonsai_web.Cont
open Bonsai.Let_syntax
open Js_of_ocaml

let class_ name = Vdom.Attr.class_ name
let text = Vdom.Node.text

let chevron_down () =
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
        ~attrs:[ Vdom.Attr.create "d" "m7 10 5 5 5-5" ]
        [];
    ]

let event_key event =
  try
    Js.to_string
      (Js.Unsafe.coerce (Js.Unsafe.get (Js.Unsafe.inject event) "key"))
  with _ -> ""

let focus id =
  Effect.of_deferred_thunk (fun () ->
      let element =
        Js.Unsafe.meth_call
          (Js.Unsafe.inject Dom_html.document)
          "getElementById"
          [| Js.Unsafe.inject (Js.string id) |]
      in
      (try ignore (Js.Unsafe.meth_call element "focus" [||]) with _ -> ());
      Async_kernel.Deferred.return ())

let category_slug category =
  String.map category ~f:(function
    | ('a' .. 'z' | '0' .. '9') as value -> value
    | _ -> '-')

let choice_id option index =
  "config-"
  ^ category_slug option.Runtime_domain.category
  ^ "-" ^ Int.to_string index

let trigger_id option =
  "config-trigger-" ^ category_slug option.Runtime_domain.category

let menu_id option =
  "config-menu-" ^ category_slug option.Runtime_domain.category

let current_name (option : Runtime_domain.config_option) =
  List.find option.choices ~f:(fun choice ->
      String.equal choice.value option.current_value)
  |> Option.value_map ~default:option.current_value ~f:(fun choice ->
      choice.name)

let component runtime ~available ~refresh ~on_error graph =
  let open_category, set_open_category = Bonsai.state None graph in
  let submitting, set_submitting = Bonsai.state None graph in
  let%arr runtime = runtime
  and available = available
  and refresh = refresh
  and on_error = on_error
  and open_category = open_category
  and submitting = submitting
  and set_open_category = set_open_category
  and set_submitting = set_submitting in
  let submit (runtime : Runtime_domain.t)
      (option : Runtime_domain.config_option) value =
    match submitting with
    | Some _ -> Effect.Ignore
    | None ->
        Effect.bind
          (Effect.Many
             [ set_submitting (Some option.config_id); set_open_category None ])
          ~f:(fun () ->
            Effect.bind
              (Effect.of_deferred_thunk (fun () ->
                   Browser_http.post_json
                     ~query:[ ("session", runtime.session_id) ]
                     "/api/v2/config-options"
                     (Runtime_domain.config_change_to_yojson runtime
                        ~mutation_id:(Command_id.create ())
                        ~config_id:option.config_id ~value)))
              ~f:(function
                | Error error ->
                    Effect.Many
                      [
                        set_submitting None;
                        on_error (Error.to_string_hum error);
                      ]
                | Ok body -> (
                    match Runtime_domain.decode_config_response body with
                    | Error message ->
                        Effect.Many [ set_submitting None; on_error message ]
                    | Ok _ ->
                        Effect.bind refresh ~f:(fun () -> set_submitting None))))
  in
  let render_control runtime (option : Runtime_domain.config_option) =
    let open_ =
      Option.value_map open_category ~default:false
        ~f:(String.equal option.category)
    in
    let idle_or_waiting =
      match runtime.Runtime_domain.status with
      | Runtime_domain.Idle | Waiting -> true
      | _ -> false
    in
    let disabled =
      Option.is_some submitting || (not available) || not idle_or_waiting
    in
    let trigger = trigger_id option in
    let menu = menu_id option in
    let move index event =
      let count = List.length option.choices in
      let destination =
        match event_key event with
        | "ArrowDown" -> Some ((index + 1) mod count)
        | "ArrowUp" -> Some ((index + count - 1) mod count)
        | "Home" -> Some 0
        | "End" -> Some (count - 1)
        | "Escape" -> None
        | _ -> Some (-1)
      in
      match destination with
      | Some -1 -> Effect.Ignore
      | Some destination ->
          Effect.Many
            [
              Vdom.Effect.Prevent_default; focus (choice_id option destination);
            ]
      | None ->
          Effect.Many
            [
              Vdom.Effect.Prevent_default; set_open_category None; focus trigger;
            ]
    in
    Vdom.Node.div
      ~attrs:[ class_ "config-control" ]
      [
        Vdom.Node.button
          ~attrs:
            ([
               Vdom.Attr.id trigger;
               class_
                 ("composer-config-trigger "
                 ^
                 if String.equal option.category "model" then "model"
                 else "thinking");
               Vdom.Attr.create "type" "button";
               Vdom.Attr.create "aria-label"
                 (option.name ^ ": " ^ current_name option);
               Vdom.Attr.create "aria-haspopup" "menu";
               Vdom.Attr.create "aria-controls" menu;
               Vdom.Attr.create "aria-expanded" (Bool.to_string open_);
               Vdom.Attr.on_click (fun _ ->
                   set_open_category
                     (if open_ then None else Some option.category));
             ]
            @ if disabled then [ Vdom.Attr.create "disabled" "" ] else [])
          [
            Vdom.Node.span
              [
                Vdom.Node.create "small" [ text option.name ];
                Vdom.Node.b
                  [
                    text
                      (if Option.is_some submitting then "Updating..."
                       else current_name option);
                  ];
              ];
            chevron_down ();
          ];
        (if not open_ then Vdom.Node.none
         else
           Vdom.Node.div
             ~attrs:
               [
                 Vdom.Attr.id menu;
                 class_
                   ("composer-config-menu "
                   ^
                   if String.equal option.category "model" then "model-menu"
                   else "thinking-menu");
                 Vdom.Attr.create "role" "menu";
                 Vdom.Attr.create "aria-label" (option.name ^ " options");
               ]
             (Vdom.Node.header
                [
                  Vdom.Node.span [ text option.name ];
                  Vdom.Node.create "small" [ text option.category ];
                ]
             :: List.mapi option.choices ~f:(fun index choice ->
                 let selected =
                   String.equal choice.value option.current_value
                 in
                 Vdom.Node.button ~key:choice.value
                   ~attrs:
                     [
                       Vdom.Attr.id (choice_id option index);
                       (if selected then class_ "selected" else class_ "");
                       Vdom.Attr.create "type" "button";
                       Vdom.Attr.create "role" "menuitemradio";
                       Vdom.Attr.create "aria-checked" (Bool.to_string selected);
                       Vdom.Attr.on_keydown (move index);
                       Vdom.Attr.on_click (fun _ ->
                           submit runtime option choice.value);
                     ]
                   [
                     Vdom.Node.create "i"
                       ~attrs:
                         [
                           class_
                             ("composer-option-check"
                             ^ if selected then " checked" else "");
                         ]
                       [ text (if selected then "x" else "") ];
                     Vdom.Node.span
                       [
                         Vdom.Node.b [ text choice.name ];
                         Vdom.Node.create "small" [ text choice.value ];
                       ];
                   ])));
      ]
  in
  match runtime with
  | None -> Vdom.Node.none
  | Some runtime ->
      let controls =
        [ "model"; "thought_level" ]
        |> List.filter_map ~f:(fun category ->
            Runtime_domain.find_category runtime category)
        |> List.map ~f:(render_control runtime)
      in
      Vdom.Node.div
        ~attrs:
          [
            class_ "composer-config";
            Vdom.Attr.create "aria-label" "Agent configuration";
          ]
        controls
