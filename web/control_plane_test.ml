open! Core

let fail message = raise_s [%message message]

let decode body =
  match Control_plane.decode_sessions body with
  | Ok sessions -> sessions
  | Error message -> fail message

let live_session =
  {|
    {
      "id": "session-live",
      "title": "Implement the OCaml shell",
      "harness": "opencode",
      "workspaceId": "workspace-a",
      "createdAt": 1723123456.5,
      "archivedAt": null,
      "workerGeneration": "generation-a",
      "upgradePending": false,
      "acceptsImages": true,
      "configOptions": [],
      "sessionId": "session-live",
      "workerId": "worker-a",
      "runtimeGeneration": 3,
      "workerPid": 4100,
      "harnessPid": 4101,
      "agentName": "OpenCode",
      "status": "running",
      "firstSequence": 12,
      "lastSequence": 48,
      "retentionPruned": false
    }
  |}

let offline_session =
  {|
    {
      "id": "session-offline",
      "title": "Offline session",
      "harness": "pi",
      "workspaceId": "workspace-a",
      "createdAt": 1723123000,
      "archivedAt": null,
      "status": "offline"
    }
  |}

let custom_harness_session =
  {|
    {
      "id": "session-custom",
      "title": "Custom adapter session",
      "harness": "acp-proxy",
      "workspaceId": "workspace-a",
      "createdAt": 1723123000,
      "archivedAt": null,
      "status": "offline"
    }
  |}

let () =
  let sessions = decode ("[" ^ live_session ^ "," ^ offline_session ^ "]") in
  (match sessions with
  | [ live; offline ] ->
      if not (String.equal live.id "session-live") then fail "wrong live id";
      if not (phys_equal live.status Control_plane.Session.Running) then
        fail "wrong live status";
      if Option.is_none live.runtime then fail "live runtime was not decoded";
      if not (phys_equal offline.status Control_plane.Session.Offline) then
        fail "wrong offline status";
      if Option.is_some offline.runtime then
        fail "offline runtime must be absent"
  | _ -> fail "wrong session count");
  (match Control_plane.decode_sessions "{}" with
  | Error message when String.is_substring message ~substring:"JSON array" -> ()
  | _ -> fail "non-array response was accepted");
  let custom = List.hd_exn (decode ("[" ^ custom_harness_session ^ "]")) in
  if
    not
      (String.equal
         (Control_plane.Session.harness_to_string custom.harness)
         "acp-proxy")
  then fail "custom harness identifier was lost";
  let mismatched =
    String.substr_replace_first live_session ~pattern:"session-live"
      ~with_:"different-session"
  in
  match Control_plane.decode_sessions ("[" ^ mismatched ^ "]") with
  | Error message when String.is_substring message ~substring:"must match id" ->
      ()
  | _ -> fail "mismatched snapshot session id was accepted"
