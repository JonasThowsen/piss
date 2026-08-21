let check_paths expected entries =
  Alcotest.(check (list string))
    "paths" expected
    (List.map (fun (entry : Audit.status_entry) -> entry.path) entries)

let entry path : Audit.status_entry =
  Audit.
    { path; previous_path = None; index_status = 'M'; worktree_status = ' ' }

let porcelain_case () =
  let output =
    "R  src/new name.ml\000src/old\n\
     name.ml\000?? odd\n\
     file.ml\000!! ignored\000"
  in
  let entries = Audit.parse_porcelain output in
  check_paths [ "src/new name.ml"; "odd\nfile.ml" ] entries;
  let renamed = List.hd entries in
  Alcotest.(check char) "rename index status" 'R' renamed.index_status;
  Alcotest.(check char) "rename worktree status" ' ' renamed.worktree_status;
  Alcotest.(check (option string))
    "rename provenance" (Some "src/old\nname.ml") renamed.previous_path

let journey_case () =
  let paths =
    Audit.select_journey
      [
        entry "docs/audit.md";
        entry "src/feature.ml";
        entry "web/audit_view.ml";
        entry "src/audit_test.ml";
        entry "flake.nix";
        entry "src/authentication.ml";
      ]
  in
  Alcotest.(check (list string))
    "feature-flow journey"
    [
      "web/audit_view.ml";
      "src/feature.ml";
      "src/authentication.ml";
      "flake.nix";
      "src/audit_test.ml";
    ]
    paths;
  Alcotest.(check string)
    "risk role" "Risk boundary"
    (fst (Audit.role_and_reason "src/authentication.ml"));
  Alcotest.(check string)
    "proof role" "Proof"
    (fst (Audit.role_and_reason "web/audit_test.ml"))

let diversity_case () =
  let entries =
    [
      entry "flake.nix";
      entry "package.json";
      entry "config/one.json";
      entry "config/two.yaml";
      entry "web/feature_view.ml";
      entry "src/feature.ml";
      entry "src/feature.mli";
      entry "src/other.ml";
      entry "src/permission_boundary.ml";
      entry "src/feature_test.ml";
    ]
  in
  let paths = Audit.select_journey entries in
  Alcotest.(check int) "five stops" 5 (List.length paths);
  let roles = List.map (fun path -> fst (Audit.role_and_reason path)) paths in
  Alcotest.(check (list string))
    "role diversity before ranked fill"
    [ "Interface"; "Implementation"; "Risk boundary"; "Configuration"; "Proof" ]
    roles;
  if List.mem "src/feature.ml" paths && List.mem "src/feature.mli" paths then
    Alcotest.fail "ml/mli companions displaced a distinct layer";
  if not (List.mem "src/permission_boundary.ml" paths) then
    Alcotest.fail "risk boundary was omitted";
  if List.hd (List.rev roles) <> "Proof" then
    Alcotest.fail "proof did not end the feature flow"

let error_category_case () =
  let open Piss_core.Error in
  let check expected actual =
    Alcotest.(check string) "typed control error" expected (to_string actual)
  in
  (match Audit.to_control_error (Audit.Validation_error "invalid layout") with
  | Validation { field = "workspace"; reason } ->
      Alcotest.(check string) "validation reason" "invalid layout" reason
  | _ -> Alcotest.fail "validation error lost its HTTP category");
  (match Audit.to_control_error (Audit.Upstream_error "Git timed out") with
  | Upstream_unavailable { message } ->
      check "Git timed out" (Upstream_unavailable { message })
  | _ -> Alcotest.fail "upstream error lost its HTTP category");
  match Audit.to_control_error Audit.Internal_error with
  | Internal { message } ->
      Alcotest.(check string)
        "generic internal message" "Audit failed unexpectedly" message
  | _ -> Alcotest.fail "internal error lost its HTTP category"

let route_case () =
  Alcotest.(check bool)
    "idle runtime can be explicitly finished" true
    (Routes.finishable_runtime_status "idle");
  List.iter
    (fun status ->
      Alcotest.(check bool)
        (status ^ " runtime fails closed for cleanup")
        false
        (Routes.finishable_runtime_status status))
    [ "offline"; "starting"; "waiting"; "running"; "requires_action"; "failed" ];
  Alcotest.(check bool)
    "broker token authorizes broker route" true
    (Routes.credential_authorized ~path:"/api/v2/broker/sessions"
       ~user_authorized:false ~has_broker_session:true);
  Alcotest.(check bool)
    "broker token cannot authorize browser route" false
    (Routes.credential_authorized ~path:"/api/v2/sessions"
       ~user_authorized:false ~has_broker_session:true);
  let parse managed method_ path =
    Routes.parse ~managed ~method_ ~uri:(Uri.of_string path) ~last_event_id:None
  in
  (match parse true `GET "/api/v2/sessions/session-a/audit" with
  | Ok (Routes.Get_session_audit "session-a") -> ()
  | _ -> Alcotest.fail "managed Audit route was not parsed");
  (match parse true `GET "/api/v2/broker/workspaces" with
  | Ok Routes.Get_broker_workspaces -> ()
  | _ -> Alcotest.fail "broker workspace list route was not parsed");
  (match parse true `POST "/api/v2/broker/workspaces" with
  | Ok Routes.Post_broker_workspaces -> ()
  | _ -> Alcotest.fail "broker workspace creation route was not parsed");
  (match parse true `POST "/api/v2/broker/workspaces/delete" with
  | Ok Routes.Post_broker_workspace_delete -> ()
  | _ -> Alcotest.fail "broker workspace deletion route was not parsed");
  (match parse true `POST "/api/v2/broker/sessions" with
  | Ok Routes.Post_broker_sessions -> ()
  | _ -> Alcotest.fail "broker session creation route was not parsed");
  (match parse true `POST "/api/v2/broker/finish" with
  | Ok Routes.Post_broker_finish -> ()
  | _ -> Alcotest.fail "broker session finish route was not parsed");
  (match parse true `GET "/api/v2/catalog-revision" with
  | Ok Routes.Get_catalog_revision -> ()
  | _ -> Alcotest.fail "catalog revision route was not parsed");
  (match parse false `GET "/api/v2/sessions/session-a/audit" with
  | Ok (Routes.Get_asset _) -> ()
  | _ -> Alcotest.fail "fixed mode exposed the managed Audit route");
  match parse true `GET "/api/v2/sessions/../../audit" with
  | Ok (Routes.Get_session_audit _) ->
      Alcotest.fail "invalid session identity was accepted"
  | _ -> ()

let write path contents =
  let channel = open_out_bin path in
  Fun.protect
    ~finally:(fun () -> close_out channel)
    (fun () -> output_string channel contents)

let git process_mgr root args =
  Eio.Process.run process_mgr
    ([
       "git";
       "-c";
       "user.name=Piss";
       "-c";
       "user.email=piss@example.test";
       "-C";
       root;
     ]
    @ args)

let git_output process_mgr root args =
  Eio.Process.parse_out process_mgr Eio.Buf_read.take_all
    ([ "git"; "-C"; root ] @ args)
  |> String.trim

let with_temporary_directory prefix operation =
  let temporary = Filename.temp_file prefix "" in
  Sys.remove temporary;
  Unix.mkdir temporary 0o700;
  Fun.protect
    ~finally:(fun () -> Lifecycle.remove_tree temporary)
    (fun () -> operation temporary)

let initialize ?(object_format = "sha1") process_mgr root =
  let format =
    if object_format = "sha1" then []
    else [ "--object-format=" ^ object_format ]
  in
  git process_mgr root ([ "init"; "-q" ] @ format);
  write (Filename.concat root "feature.ml") "let value = 1\n";
  git process_mgr root [ "add"; "feature.ml" ];
  git process_mgr root [ "commit"; "-qm"; "initial" ]

let find_file path (snapshot : Audit.snapshot) =
  List.find_opt (fun (file : Audit.file) -> file.path = path) snapshot.files

let contains value needle =
  try
    ignore (Str.search_forward (Str.regexp_string needle) value 0);
    true
  with Not_found -> false

let assert_workspace_relative_patches ~ancestor_prefix snapshot =
  List.iter
    (fun (file : Audit.file) ->
      if contains file.patch ancestor_prefix then
        Alcotest.failf "repository prefix leaked into %s patch:\n%s" file.path
          file.patch)
    snapshot.Audit.files

let direct_root_authority_case () =
  with_temporary_directory "piss-audit-direct-root-" @@ fun root ->
  Eio_main.run @@ fun env ->
  let process_mgr = Eio.Stdenv.process_mgr env in
  let clock = Eio.Stdenv.clock env in
  initialize process_mgr root;
  write (Filename.concat root "feature.ml") "let value = 2\n";
  match Audit.collect ~process_mgr ~clock ~approved_roots:[ root ] ~root with
  | Ok snapshot when Option.is_some (find_file "feature.ml" snapshot) -> ()
  | Ok _ -> Alcotest.fail "direct configured Git root omitted its change"
  | Error error ->
      Alcotest.failf "direct configured Git root was rejected: %s"
        (Audit.error_message error)

let collector_case () =
  with_temporary_directory "piss-audit-" @@ fun temporary ->
  Eio_main.run @@ fun env ->
  let process_mgr = Eio.Stdenv.process_mgr env in
  let clock = Eio.Stdenv.clock env in
  initialize process_mgr temporary;
  (match
     Audit.collect ~process_mgr ~clock ~approved_roots:[ temporary ]
       ~root:temporary
   with
  | Ok { total_files = 0; files = []; _ } -> ()
  | Ok snapshot ->
      Alcotest.failf "clean Audit returned %d changed files"
        snapshot.total_files
  | Error message -> Alcotest.fail (Audit.error_message message));
  write (Filename.concat temporary "feature.ml") "let value = 2\n";
  git process_mgr temporary [ "add"; "feature.ml" ];
  write (Filename.concat temporary "odd\nproof.ml") "let proof = true\n";
  match
    Audit.collect ~process_mgr ~clock ~approved_roots:[ temporary ]
      ~root:temporary
  with
  | Error message -> Alcotest.fail (Audit.error_message message)
  | Ok snapshot -> (
      Alcotest.(check int) "changed total" 2 snapshot.total_files;
      Alcotest.(check int) "all files accounted" 2 (List.length snapshot.files);
      if
        not
          (List.for_all
             (fun (file : Audit.file) ->
               Option.is_some file.journey_index && file.patch <> "")
             snapshot.files)
      then Alcotest.fail "changed files were not represented in the journey";
      match find_file "feature.ml" snapshot with
      | Some file when contains file.patch "# STAGED" -> ()
      | _ -> Alcotest.fail "sanitized view did not return the staged patch")

let nested_workspace_case () =
  with_temporary_directory "piss-audit-nested-" @@ fun repository ->
  Eio_main.run @@ fun env ->
  let process_mgr = Eio.Stdenv.process_mgr env in
  let clock = Eio.Stdenv.clock env in
  initialize process_mgr repository;
  let workspace = Filename.concat repository "apps/erp" in
  Lifecycle.mkdir_p workspace;
  write (Filename.concat workspace "rename-old.ml") "let renamed = 1\n";
  write (Filename.concat workspace "staged.ml") "let staged = 1\n";
  write (Filename.concat workspace "unstaged.ml") "let unstaged = 1\n";
  write (Filename.concat repository "sibling.ml") "let sibling = 1\n";
  git process_mgr repository [ "add"; "." ];
  git process_mgr repository [ "commit"; "-qm"; "nested fixture" ];
  git process_mgr repository
    [ "mv"; "apps/erp/rename-old.ml"; "apps/erp/rename-new.ml" ];
  write (Filename.concat workspace "staged.ml") "let staged = 2\n";
  git process_mgr repository [ "add"; "apps/erp/staged.ml" ];
  write (Filename.concat workspace "unstaged.ml") "let unstaged = 2\n";
  write (Filename.concat workspace "untracked.ml") "let untracked = true\n";
  write (Filename.concat repository "sibling.ml") "let sibling = 2\n";
  match
    Audit.collect ~process_mgr ~clock ~approved_roots:[ repository ]
      ~root:workspace
  with
  | Error message -> Alcotest.fail (Audit.error_message message)
  | Ok snapshot ->
      Alcotest.(check int) "nested changes only" 4 snapshot.total_files;
      let paths =
        List.map (fun (file : Audit.file) -> file.path) snapshot.files
      in
      Alcotest.(check (list string))
        "workspace-relative paths"
        [ "rename-new.ml"; "staged.ml"; "unstaged.ml"; "untracked.ml" ]
        (List.sort String.compare paths);
      if List.exists (fun path -> path = "sibling.ml") paths then
        Alcotest.fail "sibling repository change escaped workspace scope";
      assert_workspace_relative_patches ~ancestor_prefix:"apps/erp/" snapshot;
      (match find_file "rename-new.ml" snapshot with
      | Some { previous_path = Some "rename-old.ml"; patch; _ }
        when contains patch "rename from rename-old.ml"
             && contains patch "rename to rename-new.ml" ->
          ()
      | _ -> Alcotest.fail "nested rename provenance or patch path was wrong");
      List.iter
        (fun (path, content) ->
          match find_file path snapshot with
          | Some file when contains file.patch content -> ()
          | _ -> Alcotest.failf "%s patch was absent" path)
        [
          ("staged.ml", "staged = 2");
          ("unstaged.ml", "unstaged = 2");
          ("untracked.ml", "untracked = true");
        ]

let literal_pathspec_case () =
  with_temporary_directory "piss-audit-pathspec-" @@ fun repository ->
  Eio_main.run @@ fun env ->
  let process_mgr = Eio.Stdenv.process_mgr env in
  let clock = Eio.Stdenv.clock env in
  initialize process_mgr repository;
  let workspace = Filename.concat repository ":(glob)*" in
  Lifecycle.mkdir_p workspace;
  let hostile = ":(glob)*.ml" in
  write (Filename.concat workspace hostile) "let scoped = 1\n";
  write (Filename.concat repository "sibling-secret.ml") "let sibling = 1\n";
  git process_mgr repository [ "add"; "." ];
  git process_mgr repository [ "commit"; "-qm"; "literal pathspec fixture" ];
  write (Filename.concat workspace hostile) "let scoped = 2\n";
  write (Filename.concat repository "sibling-secret.ml") "let sibling = 999\n";
  match
    Audit.collect ~process_mgr ~clock ~approved_roots:[ repository ]
      ~root:workspace
  with
  | Error error -> Alcotest.fail (Audit.error_message error)
  | Ok snapshot -> (
      Alcotest.(check int) "one literal scoped change" 1 snapshot.total_files;
      match find_file hostile snapshot with
      | Some file
        when contains file.patch "scoped = 2"
             && not (contains file.patch "sibling = 999") ->
          ()
      | _ ->
          Alcotest.fail
            "pathspec magic leaked a sibling into status or the selected patch")

let nested_workspace_authority_case () =
  with_temporary_directory "piss-audit-authority-" @@ fun repository ->
  Eio_main.run @@ fun env ->
  let process_mgr = Eio.Stdenv.process_mgr env in
  let clock = Eio.Stdenv.clock env in
  initialize process_mgr repository;
  let workspace = Filename.concat repository "apps/erp" in
  Lifecycle.mkdir_p workspace;
  write (Filename.concat workspace "inside.ml") "let inside = 1\n";
  (match
     Audit.collect ~process_mgr ~clock ~approved_roots:[ workspace ]
       ~root:workspace
   with
  | Error
      (Audit.Validation_error
         "No approved Git repository contains this workspace") ->
      ()
  | Error message ->
      Alcotest.failf "unexpected authority error: %s"
        (Audit.error_message message)
  | Ok _ -> Alcotest.fail "repository ancestor outside approved roots was used");
  match
    Audit.collect ~process_mgr ~clock ~approved_roots:[ repository ]
      ~root:workspace
  with
  | Ok snapshot when Option.is_some (find_file "inside.ml" snapshot) -> ()
  | Ok _ -> Alcotest.fail "approved parent omitted nested workspace changes"
  | Error error ->
      Alcotest.failf "approved parent was rejected: %s"
        (Audit.error_message error)

let core_worktree_case () =
  with_temporary_directory "piss-audit-root-" @@ fun root ->
  with_temporary_directory "piss-audit-escape-" @@ fun outside ->
  Eio_main.run @@ fun env ->
  let process_mgr = Eio.Stdenv.process_mgr env in
  let clock = Eio.Stdenv.clock env in
  initialize process_mgr root;
  write (Filename.concat root "feature.ml") "let value = 2 (* registered *)\n";
  write (Filename.concat outside "feature.ml") "let value = 999 (* escape *)\n";
  git process_mgr root [ "config"; "core.worktree"; outside ];
  match Audit.collect ~process_mgr ~clock ~approved_roots:[ root ] ~root with
  | Error message -> Alcotest.fail (Audit.error_message message)
  | Ok snapshot -> (
      match find_file "feature.ml" snapshot with
      | None -> Alcotest.fail "registered worktree change was not collected"
      | Some file ->
          if not (contains file.patch "registered") then
            Alcotest.fail "registered patch was absent";
          if contains file.patch "999 (* escape *)" then
            Alcotest.fail "hostile core.worktree escaped the registered root")

let filter_case () =
  with_temporary_directory "piss-audit-filter-" @@ fun root ->
  Eio_main.run @@ fun env ->
  let process_mgr = Eio.Stdenv.process_mgr env in
  let clock = Eio.Stdenv.clock env in
  initialize process_mgr root;
  let marker =
    Filename.concat (Filename.get_temp_dir_name ()) "piss-filter-ran"
  in
  (try Unix.unlink marker with Unix.Unix_error (Unix.ENOENT, _, _) -> ());
  git process_mgr root [ "config"; "extensions.worktreeConfig"; "true" ];
  git process_mgr root
    [
      "config";
      "--worktree";
      "filter.audit-test.clean";
      Printf.sprintf "sh -c 'touch %s; cat'" marker;
    ];
  write (Filename.concat root ".gitattributes") "feature.ml filter=audit-test\n";
  write (Filename.concat root "feature.ml") "let value = 2\n";
  (match Audit.collect ~process_mgr ~clock ~approved_roots:[ root ] ~root with
  | Error
      (Audit.Validation_error
         "Repositories with executable Git filters or config includes cannot \
          be audited safely") ->
      ()
  | Error message ->
      Alcotest.failf "unexpected filter rejection: %s"
        (Audit.error_message message)
  | Ok _ -> Alcotest.fail "worktree-scoped executable Git filter was accepted");
  if Sys.file_exists marker then (
    Unix.unlink marker;
    Alcotest.fail "rejected filter command executed")

let processes_with_token token =
  Sys.readdir "/proc" |> Array.to_list
  |> List.filter_map (fun name ->
      match int_of_string_opt name with
      | None -> None
      | Some pid -> (
          try
            let channel =
              open_in_bin (Filename.concat "/proc" (name ^ "/cmdline"))
            in
            let contents =
              Fun.protect
                ~finally:(fun () -> close_in_noerr channel)
                (fun () ->
                  let output = Buffer.create 128 in
                  let bytes = Bytes.create 128 in
                  let rec read () =
                    let count = input channel bytes 0 (Bytes.length bytes) in
                    if count > 0 then (
                      Buffer.add_subbytes output bytes 0 count;
                      read ())
                  in
                  read ();
                  Buffer.contents output)
            in
            if contains contents token then Some pid else None
          with _ -> None))

let promisor_lazy_fetch_case () =
  with_temporary_directory "piss-audit-promisor-" @@ fun root ->
  Eio_main.run @@ fun env ->
  let process_mgr = Eio.Stdenv.process_mgr env in
  let clock = Eio.Stdenv.clock env in
  initialize process_mgr root;
  let head = git_output process_mgr root [ "rev-parse"; "HEAD" ] in
  let token =
    "piss-audit-promisor-"
    ^ string_of_int (Unix.getpid ())
    ^ "-"
    ^ string_of_int (Random.bits ())
  in
  let marker =
    Filename.concat (Filename.get_temp_dir_name ()) (token ^ ".marker")
  in
  let remote =
    Printf.sprintf
      "ext::bash -c touch%% %s;%% printf%% HELPER_EXECUTED%% >&2;%% exec%% \
       -a%% %s%% sleep%% 30"
      marker token
  in
  git process_mgr root [ "config"; "core.repositoryFormatVersion"; "1" ];
  git process_mgr root [ "config"; "extensions.partialClone"; "origin" ];
  git process_mgr root [ "config"; "remote.origin.promisor"; "true" ];
  git process_mgr root
    [ "config"; "remote.origin.partialCloneFilter"; "blob:none" ];
  git process_mgr root [ "config"; "protocol.ext.allow"; "always" ];
  git process_mgr root [ "config"; "remote.origin.url"; remote ];
  Unix.unlink
    (Filename.concat root
       (Filename.concat ".git/objects"
          (Filename.concat (String.sub head 0 2)
             (String.sub head 2 (String.length head - 2)))));
  let started = Unix.gettimeofday () in
  let result =
    Audit.collect ~process_mgr ~clock ~approved_roots:[ root ] ~root
  in
  let elapsed = Unix.gettimeofday () -. started in
  Eio.Time.sleep clock 0.05;
  let descendants = processes_with_token token in
  List.iter
    (fun pid -> try Unix.kill pid Sys.sigkill with Unix.Unix_error _ -> ())
    descendants;
  let marker_written = Sys.file_exists marker in
  if marker_written then Unix.unlink marker;
  (match result with
  | Error message
    when not (contains (Audit.error_message message) "HELPER_EXECUTED") ->
      ()
  | Error message ->
      Alcotest.failf "promisor helper executed: %s"
        (Audit.error_message message)
  | Ok _ -> Alcotest.fail "collection accepted a missing promised HEAD object");
  if elapsed > 5. then
    Alcotest.failf "promisor collection unexpectedly waited %.2fs" elapsed;
  if marker_written then
    Alcotest.fail "promisor helper wrote an external marker";
  if descendants <> [] then Alcotest.fail "promisor helper left a descendant"

let sanitized_filter_race_case () =
  with_temporary_directory "piss-audit-race-" @@ fun root ->
  Eio_main.run @@ fun env ->
  let process_mgr = Eio.Stdenv.process_mgr env in
  let clock = Eio.Stdenv.clock env in
  initialize process_mgr root;
  write
    (Filename.concat root ".gitattributes")
    "feature.ml filter=audit-race diff=audit-race\n";
  git process_mgr root [ "add"; ".gitattributes" ];
  git process_mgr root [ "commit"; "-qm"; "attributes without commands" ];
  let raw = "let value = \"SANITIZED_RAW_PATCH\"\n" in
  write (Filename.concat root "feature.ml") raw;
  let token =
    "piss-audit-race-"
    ^ string_of_int (Unix.getpid ())
    ^ "-"
    ^ string_of_int (Random.bits ())
  in
  let marker =
    Filename.concat (Filename.get_temp_dir_name ()) (token ^ ".marker")
  in
  let command =
    Printf.sprintf
      "bash -c 'touch %s; printf FILTERED_BY_RACE; exec -a %s sleep 30'" marker
      token
  in
  let hook () =
    git process_mgr root [ "config"; "filter.audit-race.clean"; command ];
    git process_mgr root [ "config"; "diff.audit-race.command"; command ]
  in
  let started = Unix.gettimeofday () in
  let result =
    Audit.collect_for_test ~process_mgr ~clock ~approved_roots:[ root ] ~root
      ~before_sanitized:hook
  in
  let elapsed = Unix.gettimeofday () -. started in
  Eio.Time.sleep clock 0.05;
  let descendants = processes_with_token token in
  List.iter
    (fun pid -> try Unix.kill pid Sys.sigkill with Unix.Unix_error _ -> ())
    descendants;
  let marker_written = Sys.file_exists marker in
  if marker_written then Unix.unlink marker;
  (match result with
  | Error message -> Alcotest.fail (Audit.error_message message)
  | Ok snapshot -> (
      match find_file "feature.ml" snapshot with
      | None -> Alcotest.fail "raced filter file was not collected"
      | Some file ->
          if not (contains file.patch "SANITIZED_RAW_PATCH") then
            Alcotest.fail "sanitized view did not return the raw patch";
          if contains file.patch "FILTERED_BY_RACE" then
            Alcotest.fail "raced repository command altered the patch"));
  if elapsed > 5. then
    Alcotest.failf "sanitized collection unexpectedly waited %.2fs" elapsed;
  if marker_written then
    Alcotest.fail "raced repository command wrote an external marker";
  if descendants <> [] then
    Alcotest.fail "raced repository command left a sleep descendant"

let metadata_identity_replacement_case () =
  with_temporary_directory "piss-audit-metadata-race-" @@ fun root ->
  Eio_main.run @@ fun env ->
  let process_mgr = Eio.Stdenv.process_mgr env in
  let clock = Eio.Stdenv.clock env in
  initialize process_mgr root;
  write (Filename.concat root "feature.ml") "let value = 2\n";
  let original = Filename.concat root ".git" in
  let displaced = Filename.concat root ".git-displaced" in
  let hook () =
    Unix.rename original displaced;
    Unix.mkdir original 0o700
  in
  let result =
    Audit.collect_for_test ~process_mgr ~clock ~approved_roots:[ root ] ~root
      ~before_sanitized:hook
  in
  (try Lifecycle.remove_tree original with _ -> ());
  Unix.rename displaced original;
  match result with
  | Error Audit.Internal_error -> ()
  | Error error ->
      Alcotest.failf "metadata replacement had wrong category: %s"
        (Audit.error_message error)
  | Ok _ -> Alcotest.fail "replaced Git metadata identity was accepted"

let linked_worktree_case () =
  with_temporary_directory "piss-audit-common-" @@ fun common ->
  with_temporary_directory "piss-audit-worktree-parent-" @@ fun parent ->
  let worktree = Filename.concat parent "checkout" in
  Eio_main.run @@ fun env ->
  let process_mgr = Eio.Stdenv.process_mgr env in
  let clock = Eio.Stdenv.clock env in
  initialize process_mgr common;
  git process_mgr common
    [ "worktree"; "add"; "-q"; "-b"; "audit-worktree"; worktree ];
  write (Filename.concat worktree "feature.ml") "let value = 3\n";
  match
    Audit.collect ~process_mgr ~clock ~approved_roots:[ worktree ]
      ~root:worktree
  with
  | Error message -> Alcotest.fail (Audit.error_message message)
  | Ok snapshot ->
      if Option.is_none (find_file "feature.ml" snapshot) then
        Alcotest.fail "registered linked worktree change was not collected"

let nested_linked_worktree_case () =
  with_temporary_directory "piss-audit-nested-common-" @@ fun common ->
  with_temporary_directory "piss-audit-nested-worktree-parent-" @@ fun parent ->
  let worktree = Filename.concat parent "checkout" in
  Eio_main.run @@ fun env ->
  let process_mgr = Eio.Stdenv.process_mgr env in
  let clock = Eio.Stdenv.clock env in
  initialize process_mgr common;
  git process_mgr common
    [ "worktree"; "add"; "-q"; "-b"; "audit-nested-worktree"; worktree ];
  let workspace = Filename.concat worktree "apps/erp" in
  Lifecycle.mkdir_p workspace;
  write (Filename.concat workspace "old.ml") "let nested = 1\n";
  write (Filename.concat worktree "sibling.ml") "let sibling = 1\n";
  git process_mgr worktree [ "add"; "." ];
  git process_mgr worktree [ "commit"; "-qm"; "nested linked fixture" ];
  git process_mgr worktree [ "mv"; "apps/erp/old.ml"; "apps/erp/new.ml" ];
  write (Filename.concat worktree "sibling.ml") "let sibling = 999\n";
  match
    Audit.collect ~process_mgr ~clock ~approved_roots:[ worktree ]
      ~root:workspace
  with
  | Error error -> Alcotest.fail (Audit.error_message error)
  | Ok snapshot -> (
      Alcotest.(check int) "linked nested changes only" 1 snapshot.total_files;
      assert_workspace_relative_patches ~ancestor_prefix:"apps/erp/" snapshot;
      match find_file "new.ml" snapshot with
      | Some { previous_path = Some "old.ml"; patch; _ }
        when not (contains patch "sibling = 999") ->
          ()
      | _ ->
          Alcotest.fail
            "nested linked rename provenance or sibling exclusion failed")

let sha256_case () =
  with_temporary_directory "piss-audit-sha256-" @@ fun root ->
  Eio_main.run @@ fun env ->
  let process_mgr = Eio.Stdenv.process_mgr env in
  let clock = Eio.Stdenv.clock env in
  initialize ~object_format:"sha256" process_mgr root;
  write (Filename.concat root "feature.ml") "let value = 256\n";
  match Audit.collect ~process_mgr ~clock ~approved_roots:[ root ] ~root with
  | Error message -> Alcotest.fail (Audit.error_message message)
  | Ok snapshot -> (
      match find_file "feature.ml" snapshot with
      | Some file when contains file.patch "value = 256" -> ()
      | _ -> Alcotest.fail "SHA-256 sanitized view omitted the changed patch")

let linked_sha256_case () =
  with_temporary_directory "piss-audit-sha256-common-" @@ fun common ->
  with_temporary_directory "piss-audit-sha256-worktree-parent-" @@ fun parent ->
  let worktree = Filename.concat parent "checkout" in
  Eio_main.run @@ fun env ->
  let process_mgr = Eio.Stdenv.process_mgr env in
  let clock = Eio.Stdenv.clock env in
  initialize ~object_format:"sha256" process_mgr common;
  git process_mgr common
    [ "worktree"; "add"; "-q"; "-b"; "audit-sha256"; worktree ];
  write (Filename.concat worktree "feature.ml") "let value = 512\n";
  match
    Audit.collect ~process_mgr ~clock ~approved_roots:[ worktree ]
      ~root:worktree
  with
  | Error message -> Alcotest.fail (Audit.error_message message)
  | Ok snapshot -> (
      match find_file "feature.ml" snapshot with
      | Some file when contains file.patch "value = 512" -> ()
      | _ ->
          Alcotest.fail
            "linked SHA-256 sanitized view omitted the changed patch")

let session_lock_case () =
  Eio_main.run @@ fun env ->
  let clock = Eio.Stdenv.clock env in
  let locks = Lifecycle.create_session_locks () in
  let first_entered, first_entered_resolver = Eio.Promise.create () in
  let release_first, release_first_resolver = Eio.Promise.create () in
  let same_session_entered = ref false in
  let same_session_done, same_session_done_resolver = Eio.Promise.create () in
  let independent_session_entered = ref false in
  Eio.Switch.run @@ fun sw ->
  Eio.Fiber.fork ~sw (fun () ->
      Lifecycle.with_session_lock locks "s-one" (fun () ->
          Eio.Promise.resolve first_entered_resolver ();
          Eio.Promise.await release_first));
  Eio.Promise.await first_entered;
  Eio.Fiber.fork ~sw (fun () ->
      Lifecycle.with_session_lock locks "s-one" (fun () ->
          same_session_entered := true;
          Eio.Promise.resolve same_session_done_resolver ()));
  Eio.Fiber.fork ~sw (fun () ->
      Lifecycle.with_session_lock locks "s-two" (fun () ->
          independent_session_entered := true));
  Eio.Time.sleep clock 0.02;
  Alcotest.(check bool)
    "same-session mutation waits behind finish" false !same_session_entered;
  Alcotest.(check bool)
    "independent session remains concurrent" true
    !independent_session_entered;
  Eio.Promise.resolve release_first_resolver ();
  Eio.Promise.await same_session_done;
  Alcotest.(check bool)
    "same-session mutation resumes after finish" true !same_session_entered

let lifecycle_process_case () =
  with_temporary_directory "piss-lifecycle-" @@ fun root ->
  let failing = Filename.concat root "failing" in
  let sleeping = Filename.concat root "sleeping" in
  write failing "#!/bin/sh\n[ \"$1\" = s-lifecycle ] || exit 9\nexit 7\n";
  write sleeping "#!/bin/sh\nsleep 2\n";
  Unix.chmod failing 0o700;
  Unix.chmod sleeping 0o700;
  Eio_main.run @@ fun env ->
  let process_mgr = Eio.Stdenv.process_mgr env in
  let clock = Eio.Stdenv.clock env in
  (match
     Lifecycle.run ~process_mgr ~clock ~timeout_seconds:1. failing "s-lifecycle"
   with
  | Error message ->
      Alcotest.(check bool)
        "non-zero lifecycle status is reported" true
        (contains message "exited with status 7")
  | Ok () -> Alcotest.fail "failing lifecycle command succeeded");
  let progressed = ref false in
  let result = ref (Ok ()) in
  let started = Unix.gettimeofday () in
  Eio.Fiber.both
    (fun () ->
      result :=
        Lifecycle.run ~process_mgr ~clock ~timeout_seconds:0.05 sleeping
          "s-lifecycle")
    (fun () ->
      Eio.Time.sleep clock 0.01;
      progressed := true);
  Alcotest.(check bool)
    "unrelated fiber progressed during lifecycle wait" true !progressed;
  Alcotest.(check bool)
    "timeout remained bounded" true
    (Unix.gettimeofday () -. started < 0.5);
  match !result with
  | Error message ->
      Alcotest.(check bool)
        "timeout is explicit" true
        (contains message "timed out after")
  | Ok () -> Alcotest.fail "sleeping lifecycle command did not time out"

let invalid_utf8_case () =
  with_temporary_directory "piss-audit-utf8-" @@ fun root ->
  Eio_main.run @@ fun env ->
  let process_mgr = Eio.Stdenv.process_mgr env in
  let clock = Eio.Stdenv.clock env in
  initialize process_mgr root;
  let invalid_path = "bad-" ^ String.make 1 (Char.chr 0xff) ^ ".ml" in
  write
    (Filename.concat root invalid_path)
    ("let value = \"" ^ String.make 1 (Char.chr 0xff) ^ "\"\n");
  match Audit.collect ~process_mgr ~clock ~approved_roots:[ root ] ~root with
  | Error message -> Alcotest.fail (Audit.error_message message)
  | Ok snapshot ->
      let json = Audit.snapshot_to_yojson snapshot |> Yojson.Safe.to_string in
      let replacement = "\xef\xbf\xbd" in
      if not (contains json replacement) then
        Alcotest.fail "invalid Git bytes were not replaced in JSON";
      ignore (Yojson.Safe.from_string json)

let () =
  Alcotest.run "control Audit"
    [
      ( "pure",
        [
          Alcotest.test_case "porcelain rename provenance" `Quick porcelain_case;
          Alcotest.test_case "journey classification" `Quick journey_case;
          Alcotest.test_case "journey diversity" `Quick diversity_case;
          Alcotest.test_case "typed error categories" `Quick error_category_case;
          Alcotest.test_case "managed route" `Quick route_case;
        ] );
      ( "integration",
        [
          Alcotest.test_case "configured repository root authority" `Quick
            direct_root_authority_case;
          Alcotest.test_case "clean and changed repository" `Quick
            collector_case;
          Alcotest.test_case "nested workspace scope and rename" `Quick
            nested_workspace_case;
          Alcotest.test_case "literal pathspec containment" `Quick
            literal_pathspec_case;
          Alcotest.test_case "nested workspace ancestor authority" `Quick
            nested_workspace_authority_case;
          Alcotest.test_case "core.worktree containment" `Quick
            core_worktree_case;
          Alcotest.test_case "worktree filter rejection" `Quick filter_case;
          Alcotest.test_case "promisor lazy-fetch suppression" `Quick
            promisor_lazy_fetch_case;
          Alcotest.test_case "post-check filter race containment" `Quick
            sanitized_filter_race_case;
          Alcotest.test_case "metadata identity replacement" `Quick
            metadata_identity_replacement_case;
          Alcotest.test_case "registered linked worktree" `Quick
            linked_worktree_case;
          Alcotest.test_case "per-session lifecycle lock" `Quick
            session_lock_case;
          Alcotest.test_case "cooperative bounded lifecycle process" `Quick
            lifecycle_process_case;
          Alcotest.test_case "nested linked worktree" `Quick
            nested_linked_worktree_case;
          Alcotest.test_case "SHA-256 repository" `Quick sha256_case;
          Alcotest.test_case "linked SHA-256 worktree" `Quick linked_sha256_case;
          Alcotest.test_case "invalid UTF-8" `Quick invalid_utf8_case;
        ] );
    ]
