open! Core
open! Bonsai_web.Cont
open Bonsai.Let_syntax

(* Hunk's useful shape is a small normalized row model: parsing, pairing, and
   word emphasis happen once for the selected file; VDOM only paints those
   rows. *)
type layout = Split | Unified
type review_note = { path : string; line : int; text : string }

let format_review_notes notes =
  "Review notes:\n\n"
  ^ (List.rev notes
    |> List.map ~f:(fun note ->
        Printf.sprintf "Review note — %s:%d\n%s" note.path note.line note.text)
    |> String.concat ~sep:"\n\n")

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

let line_number = function None -> "" | Some number -> Int.to_string number

let word_segment_view = function
  | Diff_view_domain.Plain value -> text value
  | Emphasized value ->
      Vdom.Node.create "mark" ~attrs:[ class_ "audit-diff-word" ] [ text value ]

let line_segments ?counterpart (line : Diff_view_domain.line) =
  match counterpart with
  | Some (other : Diff_view_domain.line)
    when phys_equal line.Diff_view_domain.kind Diff_view_domain.Deletion ->
      Diff_view_domain.word_segments ~original:line.Diff_view_domain.text
        ~revised:other.Diff_view_domain.text
      |> fst
      |> List.map ~f:word_segment_view
  | Some (other : Diff_view_domain.line)
    when phys_equal line.Diff_view_domain.kind Diff_view_domain.Addition ->
      Diff_view_domain.word_segments ~original:other.Diff_view_domain.text
        ~revised:line.Diff_view_domain.text
      |> snd
      |> List.map ~f:word_segment_view
  | None | Some _ -> [ text line.Diff_view_domain.text ]

let diff_cell ?counterpart ?select_line (line : Diff_view_domain.line option) =
  match line with
  | None ->
      Vdom.Node.div ~attrs:[ class_ "audit-diff-cell audit-diff-empty" ] []
  | Some line ->
      let kind =
        match line.Diff_view_domain.kind with
        | Context -> "context"
        | Addition -> "addition"
        | Deletion -> "deletion"
      in
      let sign =
        match line.Diff_view_domain.kind with
        | Context -> " "
        | Addition -> "+"
        | Deletion -> "-"
      in
      let line_note_trigger =
        Option.bind select_line ~f:(fun select_line ->
            Option.map (Option.first_some line.new_number line.old_number)
              ~f:(fun number ->
                Vdom.Node.button
                  ~attrs:
                    [
                      class_ "audit-line-note-trigger";
                      Vdom.Attr.create "type" "button";
                      Vdom.Attr.create "aria-label"
                        (Printf.sprintf "Add review note at line %d" number);
                      Vdom.Attr.on_click (fun _ -> select_line number);
                    ]
                  [ text "+" ]))
      in
      Vdom.Node.div
        ~attrs:
          [ class_ "audit-diff-cell"; Vdom.Attr.create "data-diff-kind" kind ]
        [
          Vdom.Node.span
            ~attrs:[ class_ "audit-diff-number" ]
            [ text (line_number line.Diff_view_domain.old_number) ];
          Vdom.Node.span
            ~attrs:[ class_ "audit-diff-number audit-diff-new-number" ]
            [ text (line_number line.Diff_view_domain.new_number) ];
          Vdom.Node.span ~attrs:[ class_ "audit-diff-sign" ] [ text sign ];
          Vdom.Node.code
            ~attrs:[ class_ "audit-diff-code" ]
            (line_segments ?counterpart line);
          Option.value line_note_trigger ~default:Vdom.Node.none;
        ]

let split_hunk_view ?select_line (hunk : Diff_view_domain.hunk) =
  let rows = Diff_view_domain.split_rows hunk in
  Vdom.Node.section
    ~attrs:[ class_ "audit-diff-hunk" ]
    (Vdom.Node.div
       ~attrs:[ class_ "audit-diff-hunk-header" ]
       [ text hunk.Diff_view_domain.header ]
    :: List.map rows ~f:(fun row ->
        let left_counterpart =
          match (row.left, row.right) with
          | Some left, Some right
            when phys_equal left.kind Diff_view_domain.Deletion
                 && phys_equal right.kind Diff_view_domain.Addition ->
              Some right
          | (None | Some _), (None | Some _) -> None
        in
        let right_counterpart =
          Option.map left_counterpart ~f:(fun _ -> Option.value_exn row.left)
        in
        Vdom.Node.div
          ~attrs:[ class_ "audit-diff-split-row" ]
          [
            diff_cell ?counterpart:left_counterpart ?select_line row.left;
            diff_cell ?counterpart:right_counterpart ?select_line row.right;
          ]))

let unified_hunk_view ?select_line (hunk : Diff_view_domain.hunk) =
  Vdom.Node.section
    ~attrs:[ class_ "audit-diff-hunk" ]
    (Vdom.Node.div
       ~attrs:[ class_ "audit-diff-hunk-header" ]
       [ text hunk.Diff_view_domain.header ]
    :: List.map hunk.Diff_view_domain.lines ~f:(fun line ->
        diff_cell ?select_line (Some line)))

let patch_view ?select_line file (parsed : Diff_view_domain.parsed) layout =
  if String.is_empty file.Audit_domain.patch then
    Vdom.Node.p
      ~attrs:[ class_ "audit-diff-empty-state" ]
      [
        text
          (if file.binary then "Binary change; source lines are not available."
           else "No textual patch is available for this change.");
      ]
  else if List.is_empty parsed.hunks then
    Vdom.Node.p
      ~attrs:[ class_ "audit-diff-empty-state" ]
      [ text "This patch has no renderable unified hunks." ]
  else
    Vdom.Node.div
      ~attrs:[ class_ "audit-diff-body" ]
      (List.map parsed.hunks ~f:(function hunk ->
          (match layout with
          | Split -> split_hunk_view ?select_line hunk
          | Unified -> unified_hunk_view ?select_line hunk)))

let file_picker audit ~selected_path ~select_file =
  Vdom.Node.create "nav"
    ~attrs:
      [
        class_ "audit-file-list"; Vdom.Attr.create "aria-label" "Changed files";
      ]
    (List.map audit.Audit_domain.files ~f:(fun file ->
         let selected = String.equal selected_path file.path in
         Vdom.Node.button
           ~attrs:
             [
               class_
                 (if selected then "audit-file audit-file-selected"
                  else "audit-file");
               Vdom.Attr.create "type" "button";
               Vdom.Attr.create "aria-current"
                 (if selected then "true" else "false");
               Vdom.Attr.on_click (fun _ -> select_file file.path);
             ]
           [
             Vdom.Node.span
               ~attrs:[ class_ "audit-file-path" ]
               [ text file.path ];
             Vdom.Node.span
               ~attrs:[ class_ "audit-file-meta" ]
               [ text (status file); text file.role ];
           ]))

let layout_control ~layout ~set_layout =
  let control requested label =
    Vdom.Node.button
      ~attrs:
        [
          class_
            (if phys_equal layout requested then
               "audit-layout-control audit-layout-control-active"
             else "audit-layout-control");
          Vdom.Attr.create "type" "button";
          Vdom.Attr.create "aria-pressed"
            (Bool.to_string (phys_equal layout requested));
          Vdom.Attr.on_click (fun _ -> set_layout requested);
        ]
      [ text label ]
  in
  Vdom.Node.div
    ~attrs:
      [
        class_ "audit-layout-controls";
        Vdom.Attr.create "aria-label" "Diff layout";
      ]
    [ control Split "Split"; control Unified "Unified" ]

let selected_file audit selected_path =
  List.find audit.Audit_domain.files ~f:(fun file ->
      String.equal file.path selected_path)
  |> Option.value ~default:(List.hd_exn audit.files)

let paging_controls (parsed : Diff_view_domain.parsed) ~set_page_start =
  let has_previous = parsed.first_line > 0 in
  let has_next =
    parsed.first_line + parsed.rendered_line_count < parsed.total_line_count
  in
  let button ~name ~enabled action label =
    Vdom.Node.button
      ~attrs:
        ([
           class_ "audit-page-control";
           Vdom.Attr.create "type" "button";
           Vdom.Attr.create "aria-label" name;
           Vdom.Attr.on_click (fun _ -> action ());
         ]
        @ if enabled then [] else [ Vdom.Attr.create "disabled" "" ])
      [ text label ]
  in
  Vdom.Node.div
    ~attrs:
      [
        class_ "audit-page-controls"; Vdom.Attr.create "aria-label" "Diff pages";
      ]
    [
      button ~name:"Previous diff page" ~enabled:has_previous
        (fun () ->
          set_page_start
            (Int.max 0
               (parsed.first_line - Diff_view_domain.diff_page_line_count)))
        "←";
      Vdom.Node.span
        [
          text
            (Printf.sprintf "%d–%d / %d"
               (if parsed.total_line_count = 0 then 0 else parsed.first_line + 1)
               (parsed.first_line + parsed.rendered_line_count)
               parsed.total_line_count);
        ];
      button ~name:"Next diff page" ~enabled:has_next
        (fun () ->
          set_page_start (parsed.first_line + parsed.rendered_line_count))
        "→";
    ]

let diff_view audit ~on_refresh ~selected_path ~select_file ~select_line
    ~page_start ~set_page_start ~navigator_open ~toggle_navigator ~on_close
    ~layout ~set_layout =
  let file = selected_file audit selected_path in
  let requested_page =
    Diff_view_domain.parse_unified_patch ~first_line:page_start file.patch
  in
  let parsed =
    if
      requested_page.rendered_line_count = 0
      && requested_page.total_line_count > 0
      && page_start > 0
    then
      Diff_view_domain.parse_unified_patch
        ~first_line:
          (Int.max 0
             (requested_page.total_line_count
            - Diff_view_domain.diff_page_line_count))
        file.patch
    else requested_page
  in
  let additions, deletions = Diff_view_domain.change_counts parsed in
  Vdom.Node.div
    ~attrs:[ class_ "audit-review" ]
    [
      Vdom.Node.button
        ~attrs:
          ([
             class_ "audit-navigator-scrim";
             Vdom.Attr.create "type" "button";
             Vdom.Attr.create "aria-label" "Hide changed files";
             Vdom.Attr.on_click (fun _ -> toggle_navigator ());
           ]
          @ if navigator_open then [] else [ Vdom.Attr.create "hidden" "" ])
        [];
      Vdom.Node.create "aside"
        ~attrs:
          [
            class_
              (if navigator_open then "audit-navigator audit-navigator-open"
               else "audit-navigator");
          ]
        [
          Vdom.Node.header
            [
              Vdom.Node.span [ text "CHANGED FILES" ];
              Vdom.Node.b
                [ text (Printf.sprintf "%d files" audit.accounted_files) ];
              Vdom.Node.button
                ~attrs:
                  [
                    class_ "audit-navigator-close";
                    Vdom.Attr.create "type" "button";
                    Vdom.Attr.create "aria-label" "Hide changed files";
                    Vdom.Attr.on_click (fun _ -> toggle_navigator ());
                  ]
                [ text "×" ];
              Vdom.Node.p
                [
                  text
                    "Every path is listed. Select a file to inspect its exact \
                     patch.";
                ];
            ];
          file_picker audit ~selected_path ~select_file;
        ];
      Vdom.Node.main
        ~attrs:
          [ class_ "audit-diff"; Vdom.Attr.create "aria-label" "Code diff" ]
        [
          Vdom.Node.header
            ~attrs:[ class_ "audit-diff-toolbar" ]
            [
              Vdom.Node.div
                ~attrs:[ class_ "audit-diff-identity" ]
                [
                  Vdom.Node.button
                    ~attrs:
                      [
                        class_ "audit-close";
                        Vdom.Attr.create "type" "button";
                        Vdom.Attr.create "aria-label" "Close diff viewer";
                        Vdom.Attr.on_click (fun _ -> on_close ());
                      ]
                    [ text "×" ];
                  Vdom.Node.button
                    ~attrs:
                      [
                        class_ "audit-files-toggle";
                        Vdom.Attr.create "type" "button";
                        Vdom.Attr.create "aria-expanded"
                          (Bool.to_string navigator_open);
                        Vdom.Attr.create "aria-label" "Show changed files";
                        Vdom.Attr.on_click (fun _ -> toggle_navigator ());
                      ]
                    [ text (Printf.sprintf "Files %d" audit.accounted_files) ];
                  Vdom.Node.button
                    ~attrs:
                      [
                        class_ "audit-refresh";
                        Vdom.Attr.create "type" "button";
                        Vdom.Attr.create "aria-label" "Refresh Audit";
                        Vdom.Attr.on_click (fun _ -> on_refresh ());
                      ]
                    [ text "↻" ];
                  Vdom.Node.div
                    [
                      Vdom.Node.span [ text "Review" ];
                      Vdom.Node.h2 [ text "All changed files" ];
                      Vdom.Node.p
                        [ text "Scroll through every available patch in this review." ];
                    ];
                ];
              Vdom.Node.div
                ~attrs:[ class_ "audit-diff-stats" ]
                [
                  Vdom.Node.span
                    ~attrs:[ class_ "audit-stat-addition" ]
                    [ text (Printf.sprintf "+%d" additions) ];
                  Vdom.Node.span
                    ~attrs:[ class_ "audit-stat-deletion" ]
                    [ text (Printf.sprintf "−%d" deletions) ];
                  paging_controls parsed ~set_page_start;
                  layout_control ~layout ~set_layout;
                ];
            ];
          (if file.truncated then
             Vdom.Node.p
               ~attrs:
                 [ class_ "audit-diff-limit"; Vdom.Attr.create "role" "status" ]
               [
                 text
                   "The server bounded this patch before it reached the \
                    browser.";
               ]
           else Vdom.Node.none);
          Vdom.Node.div
            ~attrs:[ class_ "audit-all-patches" ]
            (List.map audit.files ~f:(fun file ->
                 let parsed = Diff_view_domain.parse_unified_patch file.patch in
                 Vdom.Node.section
                   ~attrs:[ class_ "audit-file-patch" ]
                   [
                     Vdom.Node.header
                       ~attrs:[ class_ "audit-file-patch-header" ]
                       [
                         Vdom.Node.h3 [ text file.path ];
                         Vdom.Node.span
                           [
                             text
                               (Printf.sprintf "+%d −%d" parsed.additions
                                  parsed.deletions);
                           ];
                       ];
                     patch_view ~select_line file parsed layout;
                   ]));
        ];
    ]

let loaded_view audit ~on_refresh ~selected_path ~select_file ~select_line
    ~page_start ~set_page_start ~navigator_open ~toggle_navigator ~on_close
    ~layout ~set_layout =
  if audit.Audit_domain.total_files = 0 then
    Vdom.Node.div
      ~attrs:[ class_ "audit-state audit-clean" ]
      [
        Vdom.Node.span
          ~attrs:[ Vdom.Attr.create "aria-hidden" "true" ]
          [ text "✓" ];
        Vdom.Node.h2 [ text "Working tree is clean" ];
        Vdom.Node.p
          [
            text "There are no staged, unstaged, or untracked files to review.";
          ];
      ]
  else
    diff_view audit ~on_refresh ~selected_path ~select_file ~select_line
      ~page_start ~set_page_start ~navigator_open ~toggle_navigator ~on_close
      ~layout ~set_layout

let render state ~session_id ~on_refresh ~selected_path ~select_file
    ~select_line ~page_start ~set_page_start ~navigator_open ~toggle_navigator
    ~on_close ~layout ~set_layout =
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
            Vdom.Node.h2 [ text "Building the change review" ];
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
            Vdom.Node.h2 [ text "Review unavailable" ];
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
        let selected_path =
          if
            List.exists audit.files ~f:(fun file ->
                String.equal file.path selected_path)
          then selected_path
          else (List.hd_exn audit.files).path
        in
        loaded_view audit ~on_refresh ~selected_path ~select_file ~select_line
          ~page_start ~set_page_start ~navigator_open ~toggle_navigator
          ~on_close ~layout ~set_layout
    | Audit_domain.Dormant | Audit_domain.Loading _ | Audit_domain.Loaded _
    | Audit_domain.Failed _ ->
        Vdom.Node.div
          ~attrs:[ class_ "audit-state" ]
          [ Vdom.Node.h2 [ text "Open Changes to inspect this workspace" ] ]
  in
  Vdom.Node.section
    ~attrs:
      [
        class_ "audit-view";
        Vdom.Attr.create "aria-label" "Feature Audit";
        Vdom.Attr.create "aria-busy"
          (Bool.to_string
             (match state with Audit_domain.Loading _ -> true | _ -> false));
      ]
    [ body ]

type t = { view : Vdom.Node.t; refresh : unit -> unit Vdom.Effect.t }

let component ~session_id ~active ~runtime ~close ~submit_review_notes graph =
  let state, inject =
    Bonsai.state_machine0 ~default_model:Audit_domain.Dormant
      ~apply_action:Audit_domain.apply_load
      ~sexp_of_model:(fun _ -> Sexp.Atom "audit-load")
      ~sexp_of_action:(fun _ -> Sexp.Atom "audit-load-action")
      graph
  in
  let selected_path, set_selected_path = Bonsai.state "" graph in
  let page_start, set_page_start = Bonsai.state 0 graph in
  let navigator_open, set_navigator_open = Bonsai.state false graph in
  let review_notes, set_review_notes = Bonsai.state [] graph in
  let review_draft, set_review_draft = Bonsai.state "" graph in
  let review_line, set_review_line = Bonsai.state "" graph in
  let layout, set_layout = Bonsai.state Split graph in
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
  let%arr state = state
  and inject = inject
  and session_id = session_id
  and selected_path = selected_path
  and set_selected_path = set_selected_path
  and page_start = page_start
  and set_page_start = set_page_start
  and navigator_open = navigator_open
  and set_navigator_open = set_navigator_open
  and review_notes = review_notes
  and set_review_notes = set_review_notes
  and review_draft = review_draft
  and set_review_draft = set_review_draft
  and review_line = review_line
  and set_review_line = set_review_line
  and runtime = runtime
  and close = close
  and submit_review_notes = submit_review_notes
  and layout = layout
  and set_layout = set_layout in
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
      ~f:(fun session_id ->
        let select_file path =
          Effect.Many
            [
              set_selected_path path; set_page_start 0; set_navigator_open false;
            ]
        in
        let toggle_navigator () = set_navigator_open (not navigator_open) in
        let select_line number = set_review_line (Int.to_string number) in
        let cancel_note () =
          Effect.Many [ set_review_line ""; set_review_draft "" ]
        in
        let add_note () =
          if String.is_empty (String.strip review_draft) then Effect.Ignore
          else
            Effect.Many
              [
                set_review_notes
                  ({
                     path = selected_path;
                     line =
                       Option.value (Int.of_string_opt review_line) ~default:1;
                     text = review_draft;
                   }
                  :: review_notes);
                set_review_draft "";
              ]
        in
        let send_notes action () =
          if List.is_empty review_notes then Effect.Ignore
          else
            Effect.Many
              [
                submit_review_notes action (format_review_notes review_notes);
                set_review_notes [];
              ]
        in
        Vdom.Node.div
          [
            render state ~session_id ~on_refresh:refresh ~selected_path
              ~select_file ~select_line ~page_start ~set_page_start
              ~navigator_open ~toggle_navigator ~on_close:close ~layout
              ~set_layout;
            Vdom.Node.create "aside"
              ~attrs:
                [
                  class_
                    (if
                       String.is_empty review_line && List.is_empty review_notes
                     then "audit-review-notes audit-review-notes-empty"
                     else "audit-review-notes");
                ]
              [
                Vdom.Node.b
                  [
                    text
                      (Printf.sprintf "Review notes · %d"
                         (List.length review_notes));
                  ];
                Vdom.Node.div
                  ~attrs:
                    ([ class_ "audit-note-composer" ]
                    @
                    if String.is_empty review_line then
                      [ Vdom.Attr.create "hidden" "" ]
                    else [])
                  [
                    Vdom.Node.div
                      ~attrs:[ class_ "audit-note-composer-heading" ]
                      [
                        Vdom.Node.p [ text ("Line " ^ review_line) ];
                        Vdom.Node.button
                          ~attrs:
                            [
                              class_ "audit-note-cancel";
                              Vdom.Attr.create "type" "button";
                              Vdom.Attr.on_click (fun _ -> cancel_note ());
                            ]
                          [ text "Cancel" ];
                      ];
                    Vdom.Node.textarea
                      ~attrs:
                        [
                          Vdom.Attr.value_prop review_draft;
                          Vdom.Attr.on_input (fun _ value ->
                              set_review_draft value);
                          Vdom.Attr.create "placeholder"
                            "Note for agent about this line…";
                        ]
                      [];
                    Vdom.Node.button
                      ~attrs:
                        [
                          Vdom.Attr.create "type" "button";
                          Vdom.Attr.on_click (fun _ -> add_note ());
                        ]
                      [ text "Add note" ];
                  ];
                (match runtime with
                | Some runtime
                  when phys_equal runtime.Runtime_domain.status Running ->
                    Vdom.Node.div
                      [
                        Vdom.Node.button
                          ~attrs:
                            [
                              Vdom.Attr.create "type" "button";
                              Vdom.Attr.on_click (fun _ ->
                                  send_notes Prompt_command.Steer ());
                            ]
                          [ text "Finish · Steer next" ];
                        Vdom.Node.button
                          ~attrs:
                            [
                              Vdom.Attr.create "type" "button";
                              Vdom.Attr.on_click (fun _ ->
                                  send_notes Prompt_command.Follow_up ());
                            ]
                          [ text "Finish · Follow-up" ];
                      ]
                | None | Some _ ->
                    Vdom.Node.button
                      ~attrs:
                        [
                          Vdom.Attr.create "type" "button";
                          Vdom.Attr.on_click (fun _ ->
                              send_notes Prompt_command.Prompt ());
                        ]
                      [ text "Send review notes" ]);
              ];
          ])
  in
  { view; refresh }
