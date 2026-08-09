open! Core
open! Bonsai_web.Cont

let class_ name = Vdom.Attr.class_ name
let text = Vdom.Node.text

let fact label value =
  Vdom.Node.div [ Vdom.Node.dt [ text label ]; Vdom.Node.dd [ text value ] ]

let bool value = if value then "yes" else "no"
let optional_int = Option.value_map ~default:"not reported" ~f:Int.to_string

let render_config_option (option : Runtime_domain.config_option) =
  let choices =
    option.choices
    |> List.map ~f:(fun choice -> choice.name ^ " (" ^ choice.value ^ ")")
    |> String.concat ~sep:", "
  in
  Vdom.Node.create "article" ~key:option.config_id
    ~attrs:[ class_ "details-config-option" ]
    [
      Vdom.Node.header
        [
          Vdom.Node.b [ text option.name ];
          Vdom.Node.span [ text option.category ];
        ];
      Vdom.Node.p
        [
          Vdom.Node.span [ text "ID" ];
          Vdom.Node.strong [ text option.config_id ];
        ];
      Vdom.Node.p
        [
          Vdom.Node.span [ text "Current" ];
          Vdom.Node.strong [ text option.current_value ];
        ];
      Vdom.Node.p
        [ Vdom.Node.span [ text "Options" ]; Vdom.Node.strong [ text choices ] ];
      Option.value_map option.description ~default:Vdom.Node.none
        ~f:(fun value ->
          Vdom.Node.p
            ~attrs:[ class_ "details-config-description" ]
            [ text value ]);
    ]

let render ~(session : Control_plane.Session.t)
    ~(workspace : Workspace_catalog.workspace option)
    ~(runtime : Runtime_domain.t option) ~loading ~error =
  let workspace_name =
    Option.value_map workspace ~default:session.workspace_id ~f:(fun value ->
        value.name)
  in
  let runtime_facts =
    match runtime with
    | None ->
        [
          fact "Runtime" (if loading then "connecting" else "unavailable");
          fact "Status" (Control_plane.Session.status_to_string session.status);
        ]
    | Some runtime ->
        [
          fact "Status" (Runtime_domain.status_to_string runtime.status);
          fact "Agent" runtime.agent_name;
          fact "Worker ID" runtime.worker_id;
          fact "Worker generation" runtime.worker_generation;
          fact "Runtime generation" (Int.to_string runtime.runtime_generation);
          fact "Worker PID" (Int.to_string runtime.worker_pid);
          fact "Harness PID" (optional_int runtime.harness_pid);
          fact "First sequence" (Int64.to_string runtime.first_sequence);
          fact "Last sequence" (Int64.to_string runtime.last_sequence);
          fact "Retention pruned" (bool runtime.retention_pruned);
          fact "Upgrade pending" (bool runtime.upgrade_pending);
          fact "Accepts images" (bool runtime.accepts_images);
        ]
  in
  let config_options =
    Option.value_map runtime ~default:[] ~f:(fun value -> value.config_options)
  in
  Vdom.Node.div
    ~attrs:
      [
        class_ "session-details";
        Vdom.Attr.create "role" "region";
        Vdom.Attr.create "aria-label" "Session runtime details";
        Vdom.Attr.create "aria-busy" (Bool.to_string loading);
      ]
    [
      Vdom.Node.header
        [
          Vdom.Node.span [ text "SELECTED RUNTIME" ];
          Vdom.Node.h2 [ text session.title ];
          Vdom.Node.p
            [
              text
                (workspace_name ^ " / "
                ^ Control_plane.Session.harness_to_string session.harness);
            ];
        ];
      Option.value_map error ~default:Vdom.Node.none ~f:(fun message ->
          Vdom.Node.p
            ~attrs:[ class_ "runtime-error"; Vdom.Attr.create "role" "alert" ]
            [ text message ]);
      Vdom.Node.dl
        ([
           fact "Session ID" session.id;
           fact "Title" session.title;
           fact "Harness"
             (Control_plane.Session.harness_to_string session.harness);
           fact "Workspace ID" session.workspace_id;
           fact "Workspace" workspace_name;
           fact "Workspace root"
             (Option.value_map workspace ~default:"not reported"
                ~f:(fun value -> value.root));
           fact "Created" (Float.to_string session.created_at);
         ]
        @ runtime_facts);
      Vdom.Node.section
        ~attrs:
          [
            class_ "details-config";
            Vdom.Attr.create "aria-label" "Configuration options";
          ]
        [
          Vdom.Node.h3 [ text "NEGOTIATED CONFIGURATION" ];
          (match config_options with
          | [] -> Vdom.Node.p [ text "No configuration options reported." ]
          | options -> Vdom.Node.div (List.map options ~f:render_config_option));
        ];
    ]
