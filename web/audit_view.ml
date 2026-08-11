open! Core
open! Bonsai_web.Cont
open Bonsai.Let_syntax

let class_ name = Vdom.Attr.class_ name
let text = Vdom.Node.text
let cancel_active = ref (fun () -> ())
let next_generation = ref 0

let cancel_request () =
  !cancel_active ();
  cancel_active := fun () -> ()

let load ~inject session_id =
  cancel_request ();
  incr next_generation;
  let request : Audit_domain.request =
    { session_id; generation = !next_generation }
  in
  Effect.bind (inject (Audit_domain.Start request)) ~f:(fun () ->
      Effect.bind
        (Effect.of_deferred_thunk (fun () ->
             let deferred, cancel =
               Browser_http.get_cancelable
                 ("/api/v2/sessions/" ^ session_id ^ "/audit")
             in
             cancel_active := cancel;
             deferred))
        ~f:(function
          | Error error ->
              inject
                (Audit_domain.Rejected (request, Error.to_string_hum error))
          | Ok body -> (
              match Audit_domain.decode body with
              | Error message ->
                  inject (Audit_domain.Rejected (request, message))
              | Ok audit -> inject (Audit_domain.Succeeded (request, audit)))))

let status file =
  if String.equal file.Audit_domain.index_status "?" then "untracked"
  else if
    String.equal file.index_status "D" || String.equal file.worktree_status "D"
  then "deleted"
  else if
    String.equal file.index_status "A" || String.equal file.worktree_status "A"
  then "added"
  else if
    String.equal file.index_status "R" || String.equal file.worktree_status "R"
  then "renamed"
  else "modified"

let patch_view file =
  if String.is_empty file.Audit_domain.patch then
    Vdom.Node.p
      ~attrs:[ class_ "audit-patch-empty" ]
      [
        text
          (if file.binary then "Binary change; no textual patch is available."
           else "No textual patch is available for this change.");
      ]
  else
    Vdom.Node.pre
      ~attrs:[ class_ "audit-patch" ]
      [ Vdom.Node.code [ text file.patch ] ]

let display_path file =
  Option.value_map file.Audit_domain.previous_path ~default:file.path
    ~f:(fun previous -> previous ^ " → " ^ file.path)

let journey_stop index file =
  Vdom.Node.create "details"
    ~attrs:
      ([ class_ "audit-stop" ]
      @ if index = 1 then [ Vdom.Attr.create "open" "" ] else [])
    [
      Vdom.Node.create "summary"
        [
          Vdom.Node.span
            ~attrs:[ class_ "audit-stop-number" ]
            [ text (Printf.sprintf "%02d" index) ];
          Vdom.Node.span
            ~attrs:[ class_ "audit-stop-title" ]
            [
              Vdom.Node.small [ text file.Audit_domain.role ];
              Vdom.Node.b [ text (display_path file) ];
            ];
          Vdom.Node.span
            ~attrs:[ class_ "audit-file-status" ]
            [ text (status file) ];
          Vdom.Node.span
            ~attrs:
              [
                class_ "audit-stop-toggle";
                Vdom.Attr.create "aria-hidden" "true";
              ]
            [ text "⌄" ];
        ];
      Vdom.Node.div
        ~attrs:[ class_ "audit-stop-body" ]
        [
          Vdom.Node.p ~attrs:[ class_ "audit-reason" ] [ text file.reason ];
          (if file.truncated then
             Vdom.Node.p
               ~attrs:
                 [
                   class_ "audit-inline-warning";
                   Vdom.Attr.create "role" "status";
                 ]
               [ text "This patch was bounded by an Audit safety limit." ]
           else Vdom.Node.none);
          patch_view file;
        ];
    ]

let ledger_row file =
  let direct = Option.is_some file.Audit_domain.journey_index in
  Vdom.Node.li
    ~attrs:[ class_ (if direct then "audit-ledger-direct" else "") ]
    [
      Vdom.Node.span
        ~attrs:[ class_ "audit-ledger-mark" ]
        [ text (if direct then "✓" else "·") ];
      Vdom.Node.span
        ~attrs:[ class_ "audit-ledger-path" ]
        [
          Vdom.Node.b [ text (display_path file) ];
          Vdom.Node.small [ text (status file) ];
        ];
      Vdom.Node.span ~attrs:[ class_ "audit-ledger-role" ] [ text file.role ];
      Vdom.Node.span
        ~attrs:[ class_ "audit-ledger-coverage" ]
        [ text (if direct then "Journey" else "Accounted") ];
    ]

let loaded_view audit ~on_refresh =
  if audit.Audit_domain.total_files = 0 then
    Vdom.Node.div
      ~attrs:[ class_ "audit-state audit-clean" ]
      [
        Vdom.Node.span
          ~attrs:[ Vdom.Attr.create "aria-hidden" "true" ]
          [ text "✓" ];
        Vdom.Node.h2 [ text "Working tree is clean" ];
        Vdom.Node.p
          [ text "There are no staged, unstaged, or untracked files to audit." ];
        Vdom.Node.button
          ~attrs:
            [
              Vdom.Attr.create "type" "button";
              Vdom.Attr.on_click (fun _ -> on_refresh ());
            ]
          [ text "Refresh Audit" ];
      ]
  else
    let journey = Audit_domain.journey audit in
    Vdom.Node.div
      ~attrs:[ class_ "audit-content" ]
      [
        (if audit.truncated then
           Vdom.Node.p
             ~attrs:[ class_ "audit-warning"; Vdom.Attr.create "role" "status" ]
             [
               text
                 (Printf.sprintf
                    "Audit limits were reached. %d of %d changed paths are \
                     listed; bounded patches are marked."
                    audit.accounted_files audit.total_files);
             ]
         else Vdom.Node.none);
        Vdom.Node.section
          ~attrs:
            [
              class_ "audit-journey";
              Vdom.Attr.create "aria-label" "Review journey";
            ]
          ([
             Vdom.Node.header
               [
                 Vdom.Node.div
                   [
                     Vdom.Node.span [ text "FEATURE JOURNEY" ];
                     Vdom.Node.h2 [ text "Read the design end to end" ];
                   ];
                 Vdom.Node.p
                   [
                     text
                       "Stops are selected by transparent risk and coverage \
                        heuristics—not as a claim that omitted code was \
                        independently reviewed.";
                   ];
               ];
           ]
          @ List.mapi journey ~f:(fun index file ->
              journey_stop (index + 1) file));
        Vdom.Node.section
          ~attrs:
            [
              class_ "audit-ledger";
              Vdom.Attr.create "aria-label" "Change coverage ledger";
            ]
          [
            Vdom.Node.header
              [
                Vdom.Node.div
                  [
                    Vdom.Node.span [ text "COVERAGE LEDGER" ];
                    Vdom.Node.h2
                      [
                        text
                          (if audit.accounted_files = audit.total_files then
                             "Every changed path, accounted for"
                           else "Bounded change coverage");
                      ];
                  ];
                Vdom.Node.p
                  [
                    Vdom.Node.b
                      [
                        text
                          (Printf.sprintf "%d / %d" audit.accounted_files
                             audit.total_files);
                      ];
                    text " paths listed";
                  ];
              ];
            Vdom.Node.ol (List.map audit.files ~f:ledger_row);
          ];
      ]

let render state ~session_id ~on_refresh =
  let body =
    match state with
    | Audit_domain.Loading current
      when String.equal current.session_id session_id ->
        Vdom.Node.div
          ~attrs:
            [
              class_ "audit-state audit-loading";
              Vdom.Attr.create "role" "status";
            ]
          [
            Vdom.Node.span [ text "···" ];
            Vdom.Node.h2 [ text "Building the Audit journey" ];
            Vdom.Node.p
              [
                text "Reading bounded staged, unstaged, and untracked changes…";
              ];
          ]
    | Audit_domain.Failed (current, message)
      when String.equal current.session_id session_id ->
        Vdom.Node.div
          ~attrs:
            [
              class_ "audit-state audit-error"; Vdom.Attr.create "role" "alert";
            ]
          [
            Vdom.Node.span [ text "!" ];
            Vdom.Node.h2 [ text "Audit unavailable" ];
            Vdom.Node.p [ text message ];
            Vdom.Node.button
              ~attrs:
                [
                  Vdom.Attr.create "type" "button";
                  Vdom.Attr.on_click (fun _ -> on_refresh ());
                ]
              [ text "Try again" ];
          ]
    | Audit_domain.Loaded (current, audit)
      when String.equal current.session_id session_id ->
        loaded_view audit ~on_refresh
    | Audit_domain.Dormant | Audit_domain.Loading _ | Audit_domain.Loaded _
    | Audit_domain.Failed _ ->
        Vdom.Node.div
          ~attrs:[ class_ "audit-state" ]
          [ Vdom.Node.h2 [ text "Open Audit to read this feature journey" ] ]
  in
  let audit = Audit_domain.snapshot_for state ~session_id in
  Vdom.Node.section
    ~attrs:
      [
        class_ "audit-view";
        Vdom.Attr.create "aria-label" "Feature Audit";
        Vdom.Attr.create "aria-busy"
          (Bool.to_string
             (match state with Audit_domain.Loading _ -> true | _ -> false));
      ]
    [
      Vdom.Node.header
        ~attrs:[ class_ "audit-overview" ]
        [
          Vdom.Node.div
            [
              Vdom.Node.span [ text "SIGN-OFF / AUDIT" ];
              Vdom.Node.h1 [ text "Audit" ];
              Vdom.Node.p
                [
                  text
                    (Option.value_map audit
                       ~default:
                         "A guided review of this session's workspace changes"
                       ~f:(fun audit ->
                         Printf.sprintf
                           "%d journey stops · %d changed paths · %d accounted"
                           audit.highlighted_files audit.total_files
                           audit.accounted_files));
                ];
            ];
          Vdom.Node.button
            ~attrs:
              ([
                 class_ "audit-refresh";
                 Vdom.Attr.create "type" "button";
                 Vdom.Attr.create "aria-label" "Refresh Audit";
                 Vdom.Attr.on_click (fun _ -> on_refresh ());
               ]
              @
              match state with
              | Audit_domain.Loading _ -> [ Vdom.Attr.create "disabled" "" ]
              | _ -> [])
            [ text "↻  Refresh" ];
        ];
      body;
    ]

type t = { view : Vdom.Node.t; refresh : unit -> unit Vdom.Effect.t }

let component ~session_id ~active graph =
  let state, inject =
    Bonsai.state_machine0 ~default_model:Audit_domain.Dormant
      ~apply_action:Audit_domain.apply_load
      ~sexp_of_model:(fun _ -> Sexp.Atom "audit-load")
      ~sexp_of_action:(fun _ -> Sexp.Atom "audit-load-action")
      graph
  in
  let key =
    let%arr session_id = session_id and active = active in
    if active then session_id else None
  in
  let on_key =
    let%arr inject = inject in
    function
    | None ->
        cancel_request ();
        inject Audit_domain.Deactivate
    | Some session_id -> load ~inject session_id
  in
  Bonsai.Edge.on_change key
    ~equal:(Option.equal String.equal)
    ~callback:on_key graph;
  let%arr state = state and inject = inject and session_id = session_id in
  let refresh () =
    Option.value_map session_id ~default:Effect.Ignore ~f:(load ~inject)
  in
  let view =
    Option.value_map session_id
      ~default:
        (Vdom.Node.section
           ~attrs:
             [
               class_ "audit-view";
               Vdom.Attr.create "aria-label" "Feature Audit";
             ]
           [])
      ~f:(fun session_id -> render state ~session_id ~on_refresh:refresh)
  in
  { view; refresh }
