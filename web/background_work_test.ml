open! Core

let fail message = raise_s [%message message]

let valid =
  {|{
    "kind":"pi-subagents.async-status-snapshot",
    "version":1,
    "generatedAt":1787596000000,
    "omitted":{"runs":0,"children":0,"byteLimitExceeded":false},
    "runs":[{
      "id":"async-run",
      "kind":"workflow",
      "label":"worker, reviewer",
      "state":"running",
      "activity":{"state":"active","currentTool":"bash","turnCount":3,"toolCount":9},
      "children":[{
        "id":"implementation",
        "kind":"step",
        "label":"worker",
        "state":"running",
        "activity":{"currentTool":"nix develop"}
      }]
    }]
  }|}

let () =
  let snapshot =
    match
      Background_work.decode ~path:"snapshot" (Yojson.Safe.from_string valid)
    with
    | Ok snapshot -> snapshot
    | Error message -> fail message
  in
  (match snapshot.runs with
  | [
   {
     id = "async-run";
     state = Background_work.Running;
     children = [ child ];
     activity = Some activity;
     _;
   };
  ] ->
      if
        not
          (String.equal child.label "worker"
          && Option.equal String.equal activity.current_tool (Some "bash"))
      then fail "background work activity was decoded incorrectly"
  | _ -> fail "background work tree was not decoded");
  let oversized_runs =
    List.init 21 ~f:(fun index ->
        `Assoc
          [
            ("id", `String ("run-" ^ Int.to_string index));
            ("kind", `String "subagent");
            ("label", `String "worker");
            ("state", `String "running");
          ])
  in
  let oversized =
    `Assoc
      [
        ("kind", `String "pi-subagents.async-status-snapshot");
        ("version", `Int 1);
        ("generatedAt", `Intlit "1787596000000");
        ("omitted", `Assoc [ ("runs", `Int 0); ("children", `Int 0) ]);
        ("runs", `List oversized_runs);
      ]
  in
  (match Background_work.decode ~path:"snapshot" oversized with
  | Error message when String.is_substring message ~substring:"at most 20" -> ()
  | Error message -> fail ("unexpected bound error: " ^ message)
  | Ok _ -> fail "oversized background snapshot was accepted");
  let history =
    {|[
      {"sequence":1,"kind":"acp.session_info_update","payload":{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session","update":{"sessionUpdate":"session_info_update","_meta":{"piAcp":{"subagents":{"kind":"pi-subagents.async-status-snapshot","version":1,"runs":[{"id":"adapter-minimal","state":"running"}]}}}}}},"createdAt":1},
      {"sequence":2,"kind":"command.accepted","payload":{"commandId":"after-progress","requestId":"after-progress","action":"prompt","text":"still visible","imageCount":0,"images":[],"resourceCount":0,"resources":[]},"createdAt":2}
    ]|}
  in
  let events =
    match Event_history.decode_events history with
    | Ok events -> events
    | Error message ->
        fail ("optional progress rejected its event page: " ^ message)
  in
  match Event_history.project events with
  | [ Event_history.User { command_id = "after-progress"; _ } ] -> ()
  | _ -> fail "malformed optional progress hid a valid durable event"
