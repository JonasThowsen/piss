open! Core

let fail message = raise_s [%message message]

let fixture =
  {|
  {
    "audit": {
      "generatedAt": 1723123456789,
      "totalFiles": 3,
      "accountedFiles": 3,
      "highlightedFiles": 2,
      "truncated": false,
      "files": [
        {
          "path": "src/authentication.ml",
          "previousPath": "src/old_authentication.ml",
          "indexStatus": "R",
          "worktreeStatus": " ",
          "patch": "@@ -1 +1 @@\n-old\n+new\n",
          "truncated": false,
          "binary": false,
          "role": "Risk boundary",
          "reason": "Authentication is a risk boundary.",
          "journeyIndex": 1
        },
        {
          "path": "odd\nproof.ml",
          "previousPath": null,
          "indexStatus": "?",
          "worktreeStatus": "?",
          "patch": "@@ -0,0 +1 @@\n+let proof = true\n",
          "truncated": false,
          "binary": false,
          "role": "Proof",
          "reason": "Executable proof.",
          "journeyIndex": 2
        },
        {
          "path": "docs/audit.md",
          "previousPath": null,
          "indexStatus": "M",
          "worktreeStatus": " ",
          "patch": "",
          "truncated": false,
          "binary": false,
          "role": "Documentation",
          "reason": "Supporting explanation.",
          "journeyIndex": null
        }
      ]
    }
  }
  |}

let decode () =
  match Audit_domain.decode fixture with
  | Error message -> fail message
  | Ok audit -> audit

let request session_id generation : Audit_domain.request =
  { session_id; generation }

let () =
  let audit = decode () in
  if audit.total_files <> 3 || audit.accounted_files <> 3 then
    fail "coverage counts were not decoded";
  (match Audit_domain.journey audit with
  | [ first; second ] ->
      if not (String.equal first.path "src/authentication.ml") then
        fail "journey order changed";
      if
        not
          (Option.equal String.equal first.previous_path
             (Some "src/old_authentication.ml"))
      then fail "rename provenance was not decoded";
      if not (String.equal second.path "odd\nproof.ml") then
        fail "unusual path was not preserved"
  | _ -> fail "journey did not contain two stops");
  let invalid =
    String.substr_replace_first fixture ~pattern:"\"accountedFiles\": 3"
      ~with_:"\"accountedFiles\": 2"
  in
  (match Audit_domain.decode invalid with
  | Error message
    when String.is_substring message ~substring:"must equal files.length" ->
      ()
  | _ -> fail "incomplete coverage contract was accepted");
  let first = request "session-a" 1 in
  let refreshed = request "session-a" 2 in
  let loading_first =
    Audit_domain.apply_load () Audit_domain.Dormant (Audit_domain.Start first)
  in
  let loading_refresh =
    Audit_domain.apply_load () loading_first (Audit_domain.Start refreshed)
  in
  let stale_same_session =
    Audit_domain.apply_load () loading_refresh
      (Audit_domain.Succeeded (first, audit))
  in
  if
    Option.is_some
      (Audit_domain.snapshot_for stale_same_session ~session_id:"session-a")
  then fail "same-session stale refresh response won";
  let loaded =
    Audit_domain.apply_load () stale_same_session
      (Audit_domain.Succeeded (refreshed, audit))
  in
  if Option.is_none (Audit_domain.snapshot_for loaded ~session_id:"session-a")
  then fail "current refresh response was not retained";
  let session_b = request "session-b" 3 in
  let returned_a = request "session-a" 4 in
  let aba =
    loaded |> fun state ->
    Audit_domain.apply_load () state (Audit_domain.Start session_b)
    |> fun state ->
    Audit_domain.apply_load () state (Audit_domain.Start returned_a)
    |> fun state ->
    Audit_domain.apply_load () state (Audit_domain.Succeeded (first, audit))
  in
  if Option.is_some (Audit_domain.snapshot_for aba ~session_id:"session-a") then
    fail "A-B-A stale response won without matching generation"
