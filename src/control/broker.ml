(* Inter-session request broker used by the PISS-provided MCP tools. *)

open Piss_core

type observation =
  | Peer_pending
  | Peer_completed of string
  | Peer_failed of string

let worker_request ~net socket request =
  Worker_client.request ~net ~socket request

let runtime_target ~net socket =
  match worker_request ~net socket (`Assoc [ ("op", `String "snapshot") ]) with
  | Error error -> Error error
  | Ok snapshot -> (
      let open Yojson.Safe.Util in
      let target =
        `Assoc
          [
            ("sessionId", member "sessionId" snapshot);
            ("workerId", member "workerId" snapshot);
            ("runtimeGeneration", member "runtimeGeneration" snapshot);
          ]
      in
      let probe =
        `Assoc
          [
            ("op", `String "prompt");
            ("target", target);
            ("commandId", `String "broker-target-probe");
            ("text", `String "probe");
          ]
      in
      match Wire.request_of_yojson probe with
      | Ok _ -> Ok target
      | Error message ->
          Error
            (Error.Upstream_unavailable
               {
                 message =
                   "worker returned an invalid runtime target: " ^ message;
               }))

let prompt_request ~net socket ~command_id ~text =
  Result.map
    (fun target ->
      `Assoc
        [
          ("op", `String "prompt");
          ("target", target);
          ("commandId", `String command_id);
          ("text", `String text);
        ])
    (runtime_target ~net socket)

let peer_event ~net (manager : Config.managed_workers)
    (session : Registry.session) ~kind ~request_id ~peer_id ~text =
  worker_request ~net
    (Lifecycle.session_socket manager.runtime_root session.id)
    (`Assoc
       [
         ("op", `String "peer_event");
         ("kind", `String kind);
         ("requestId", `String request_id);
         ("peerId", `String peer_id);
         ("text", `String text);
       ])

let event_sequence event =
  match Yojson.Safe.Util.member "sequence" event with
  | `Int value -> Int64.of_int value
  | `Intlit value -> Option.value ~default:0L (Int64.of_string_opt value)
  | _ -> 0L

let agent_chunk_text event =
  let open Yojson.Safe.Util in
  if member "kind" event <> `String "acp.agent_message_chunk" then ""
  else
    match
      event |> member "payload" |> member "params" |> member "update"
      |> member "content" |> member "text"
    with
    | `String value -> value
    | _ -> ""

let command_terminal_state command_id event =
  let open Yojson.Safe.Util in
  let kind = member "kind" event in
  if kind <> `String "command.state" && kind <> `String "command.reconciled"
  then None
  else
    let payload = member "payload" event in
    match (member "commandId" payload, member "state" payload) with
    | `String id, `String state when String.equal id command_id ->
        if
          List.exists (String.equal state)
            [ "completed"; "cancelled"; "rejected"; "ambiguous" ]
        then Some state
        else None
    | _ -> None

let is_command_accepted command_id event =
  let open Yojson.Safe.Util in
  if member "kind" event <> `String "command.accepted" then false
  else member "commandId" (member "payload" event) = `String command_id

let inspect_peer_response ~net ~socket (request : Registry.peer_request) =
  let rec pages cursor chunks command_seen =
    match
      worker_request ~net socket
        (`Assoc
           [
             ("op", `String "events");
             ("after", `Intlit (Int64.to_string cursor));
             ("limit", `Int 200);
           ])
    with
    | Error _ -> Peer_pending
    | Ok (`List events) -> (
        let cursor =
          List.fold_left
            (fun latest event -> Int64.max latest (event_sequence event))
            cursor events
        in
        let rec collect_until_terminal seen collected = function
          | [] -> (seen, collected, None)
          | event :: rest -> (
              let seen = seen || is_command_accepted request.command_id event in
              match command_terminal_state request.command_id event with
              | Some state -> (seen, collected, Some state)
              | None ->
                  let text = if seen then agent_chunk_text event else "" in
                  let collected =
                    if String.equal text "" then collected
                    else text :: collected
                  in
                  collect_until_terminal seen collected rest)
        in
        let command_seen, chunks, terminal =
          collect_until_terminal command_seen chunks events
        in
        match terminal with
        | Some "completed" ->
            Peer_completed (String.concat "" (List.rev chunks))
        | Some state -> Peer_failed ("peer session ended as " ^ state)
        | None when List.length events = 200 -> pages cursor chunks command_seen
        | None -> Peer_pending)
    | Ok _ -> Peer_failed "peer worker returned an invalid event page"
  in
  pages request.start_sequence [] false

let target_sequence ~net (manager : Config.managed_workers)
    (target : Registry.session) =
  match
    worker_request ~net
      (Lifecycle.session_socket manager.runtime_root target.id)
      (`Assoc [ ("op", `String "snapshot") ])
  with
  | Ok snapshot -> (
      match Yojson.Safe.Util.member "lastSequence" snapshot with
      | `Int value -> Int64.of_int value
      | `Intlit value -> Option.value ~default:0L (Int64.of_string_opt value)
      | _ -> 0L)
  | Error _ -> 0L

let dispatch_peer_request ~net (manager : Config.managed_workers)
    ~(source : Registry.session) ~(target : Registry.session)
    (request : Registry.peer_request) =
  if String.equal request.state "completed" then Ok request
  else
    let was_new = String.equal request.state "accepted" in
    let request, dispatch_transition =
      if List.mem request.state [ "accepted"; "queued" ] then (
        Registry.mark_peer_dispatching manager.registry request.id
          ~start_sequence:(target_sequence ~net manager target);
        ( Option.get (Registry.find_peer_request manager.registry request.id),
          true ))
      else (request, false)
    in
    let target_prompt =
      Printf.sprintf
        "Inter-session request from %s (%s):\n\n\
         %s\n\n\
         Respond directly to the requesting session."
        source.title source.id request.prompt
    in
    let socket = Lifecycle.session_socket manager.runtime_root target.id in
    match
      Result.bind
        (prompt_request ~net socket ~command_id:request.command_id
           ~text:target_prompt)
        (worker_request ~net socket)
    with
    | Error message ->
        Registry.update_peer_request manager.registry request.id ~state:"queued"
          ~response:None;
        if was_new then
          ignore
            (peer_event ~net manager source ~kind:"session.ask.queued"
               ~request_id:request.id ~peer_id:target.id ~text:request.prompt);
        Error message
    | Ok _ ->
        Registry.update_peer_request manager.registry request.id
          ~state:"dispatched" ~response:None;
        if dispatch_transition then (
          ignore
            (peer_event ~net manager source ~kind:"session.ask.dispatched"
               ~request_id:request.id ~peer_id:target.id ~text:request.prompt);
          ignore
            (peer_event ~net manager target ~kind:"session.ask.received"
               ~request_id:request.id ~peer_id:source.id ~text:request.prompt));
        Ok (Option.get (Registry.find_peer_request manager.registry request.id))

let complete_peer_observation ~net (manager : Config.managed_workers)
    ~(source : Registry.session) (request : Registry.peer_request) observation =
  match observation with
  | Peer_completed response ->
      if Registry.complete_peer_request manager.registry request.id response
      then
        ignore
          (peer_event ~net manager source ~kind:"session.ask.completed"
             ~request_id:request.id ~peer_id:request.target_id ~text:response);
      Peer_completed response
  | Peer_failed message ->
      Registry.update_peer_request manager.registry request.id ~state:"failed"
        ~response:(Some message);
      ignore
        (peer_event ~net manager source ~kind:"session.ask.failed"
           ~request_id:request.id ~peer_id:request.target_id ~text:message);
      Peer_failed message
  | observation -> observation

let reconcile_peer_request ~net (manager : Config.managed_workers)
    ~(source : Registry.session) (request : Registry.peer_request) =
  match request.state with
  | "completed" -> Peer_completed (Option.value ~default:"" request.response)
  | "failed" ->
      Peer_failed (Option.value ~default:"peer request failed" request.response)
  | _ -> (
      match Registry.find_active manager.registry request.target_id with
      | None ->
          complete_peer_observation ~net manager ~source request
            (Peer_failed "target session is not active")
      | Some target -> (
          match dispatch_peer_request ~net manager ~source ~target request with
          | Error _ -> Peer_pending
          | Ok dispatched ->
              inspect_peer_response ~net
                ~socket:
                  (Lifecycle.session_socket manager.runtime_root target.id)
                dispatched
              |> complete_peer_observation ~net manager ~source dispatched))

let wait_for_peer_response ~net ~clock (manager : Config.managed_workers)
    ~(source : Registry.session) request =
  let deadline = Unix.gettimeofday () +. 600. in
  let rec loop () =
    match reconcile_peer_request ~net manager ~source request with
    | Peer_pending when Unix.gettimeofday () < deadline ->
        Eio.Time.sleep clock 0.25;
        loop ()
    | Peer_pending -> Error "peer session timed out"
    | Peer_completed response -> Ok response
    | Peer_failed message -> Error message
  in
  loop ()

let accept_peer_json ~net (manager : Config.managed_workers)
    ~(source : Registry.session) json =
  let open Yojson.Safe.Util in
  let request_id = json |> member "requestId" |> to_string in
  let target_id = json |> member "targetSessionId" |> to_string in
  let prompt = json |> member "prompt" |> to_string in
  if request_id = "" || String.length request_id > 100 then
    Error "requestId must contain between 1 and 100 characters"
  else if prompt = "" || String.length prompt > 64 * 1024 then
    Error "prompt must contain between 1 and 65536 characters"
  else if String.equal source.id target_id then
    Error "a session cannot ask itself"
  else
    match Registry.find_active manager.registry target_id with
    | None -> Error "target session is not active"
    | Some target -> (
        let command_id = "peer-" ^ Digest.to_hex (Digest.string request_id) in
        let existing = Registry.find_peer_request manager.registry request_id in
        match existing with
        | Some request
          when not
                 (String.equal request.source_id source.id
                 && String.equal request.target_id target.id
                 && String.equal request.prompt prompt) ->
            Error "requestId belongs to a different peer request"
        | Some request -> Ok (request, true)
        | None ->
            let request, _ =
              Registry.accept_peer_request manager.registry ~id:request_id
                ~source_id:source.id ~target_id:target.id ~prompt ~command_id
                ~start_sequence:0L
            in
            ignore
              (peer_event ~net manager source ~kind:"session.ask.sent"
                 ~request_id ~peer_id:target.id ~text:prompt);
            Ok (request, false))

let send_peer_request ~net (manager : Config.managed_workers)
    ~(source : Registry.session) json =
  match accept_peer_json ~net manager ~source json with
  | Error message -> Error message
  | Ok (request, duplicate) ->
      let request =
        match Registry.find_active manager.registry request.target_id with
        | None -> request
        | Some target -> (
            match
              dispatch_peer_request ~net manager ~source ~target request
            with
            | Ok dispatched -> dispatched
            | Error _ ->
                Option.get
                  (Registry.find_peer_request manager.registry request.id))
      in
      Ok (request, duplicate)

let peer_request_json (request : Registry.peer_request) =
  `Assoc
    [
      ("requestId", `String request.id);
      ("targetSessionId", `String request.target_id);
      ("state", `String request.state);
      ( "response",
        Option.fold ~none:`Null
          ~some:(fun value -> `String value)
          request.response );
    ]

let collect_peer_requests ~net ~clock (manager : Config.managed_workers)
    ~(source : Registry.session) ~request_ids ~wait_for ~timeout =
  let deadline = Unix.gettimeofday () +. timeout in
  let selected_requests () =
    List.map
      (fun id ->
        match Registry.find_peer_request manager.registry id with
        | Some request when String.equal request.source_id source.id -> request
        | Some _ ->
            raise (Invalid_argument "peer request belongs to another session")
        | None -> raise (Invalid_argument ("unknown peer request: " ^ id)))
      request_ids
  in
  let rec listen () =
    let requests = selected_requests () in
    List.iter
      (fun request ->
        ignore (reconcile_peer_request ~net manager ~source request))
      requests;
    let requests = selected_requests () in
    let finished, pending =
      List.partition
        (fun (request : Registry.peer_request) ->
          List.exists (String.equal request.state) [ "completed"; "failed" ])
        requests
    in
    let ready =
      match wait_for with
      | "any" -> finished <> []
      | "all" -> pending = []
      | _ -> raise (Invalid_argument "waitFor must be 'any' or 'all'")
    in
    if ready || Unix.gettimeofday () >= deadline then (finished, pending)
    else (
      Eio.Time.sleep clock 0.25;
      listen ())
  in
  listen ()

let subscription_requests (manager : Config.managed_workers)
    (source : Registry.session) (subscription : Registry.peer_subscription) =
  List.map
    (fun id ->
      match Registry.find_peer_request manager.registry id with
      | Some request when String.equal request.source_id source.id -> request
      | Some _ ->
          raise
            (Invalid_argument
               "peer subscription contains another source's request")
      | None ->
          raise
            (Invalid_argument
               ("peer subscription contains unknown request: " ^ id)))
    subscription.request_ids

let peer_request_finished (request : Registry.peer_request) =
  List.exists (String.equal request.state) [ "completed"; "failed" ]

let peer_subscription_ready (subscription : Registry.peer_subscription) requests
    =
  match subscription.wait_for with
  | "any" -> List.exists peer_request_finished requests
  | "all" -> List.for_all peer_request_finished requests
  | _ -> false

let peer_wake_prompt (subscription : Registry.peer_subscription) requests =
  let request_text (request : Registry.peer_request) =
    Printf.sprintf "\nRequest %s\nTarget: %s\nState: %s\nResponse:\n%s\n"
      request.id request.target_id request.state
      (Option.value ~default:"(no response)" request.response)
  in
  let pending, finished =
    List.partition (Fun.negate peer_request_finished) requests
  in
  let full =
    Printf.sprintf
      "PISS durable collaboration wake-up.\n\n\
       Subscription %s is ready (waitFor=%s). Your previous turn ended while \
       these sessions continued independently. Review the captured results \
       below and continue the orchestration. Do not redispatch completed \
       requests.\n\
       %s%s"
      subscription.id subscription.wait_for
      (finished |> List.map request_text |> String.concat "")
      (match pending with
      | [] -> ""
      | requests ->
          "\nStill pending:\n"
          ^ (requests
            |> List.map (fun (request : Registry.peer_request) ->
                "- " ^ request.id ^ "\n")
            |> String.concat ""))
  in
  let limit = (60 * 1024) - 32 in
  if String.length full <= limit then full
  else String.sub full 0 limit ^ "\n[responses truncated by PISS]\n"

let accept_peer_subscription (manager : Config.managed_workers)
    ~(source : Registry.session) json =
  let open Yojson.Safe.Util in
  let id = json |> member "subscriptionId" |> to_string in
  let request_ids =
    json |> member "requestIds" |> to_list |> List.map to_string
    |> List.sort_uniq String.compare
  in
  let wait_for =
    match member "waitFor" json with `String value -> value | _ -> "all"
  in
  if id = "" || String.length id > 100 then
    Error "subscriptionId must contain between 1 and 100 characters"
  else if request_ids = [] || List.length request_ids > 64 then
    Error "requestIds must contain between 1 and 64 identities"
  else if not (List.mem wait_for [ "any"; "all" ]) then
    Error "waitFor must be 'any' or 'all'"
  else
    let requests =
      List.map
        (fun request_id ->
          match Registry.find_peer_request manager.registry request_id with
          | Some request when String.equal request.source_id source.id ->
              request
          | Some _ ->
              raise
                (Invalid_argument
                   "peer request belongs to another source session")
          | None ->
              raise (Invalid_argument ("unknown peer request: " ^ request_id)))
        request_ids
    in
    let command_id = "peer-wake-" ^ Digest.to_hex (Digest.string id) in
    let subscription, duplicate =
      Registry.accept_peer_subscription manager.registry ~id
        ~source_id:source.id ~request_ids ~wait_for ~command_id
    in
    if
      duplicate
      && not
           (String.equal subscription.source_id source.id
           && subscription.request_ids = request_ids
           && String.equal subscription.wait_for wait_for)
    then Error "subscriptionId belongs to a different peer subscription"
    else
      let _ = requests in
      Ok (subscription, duplicate)

let bounded_subscription_operation ~clock operation =
  try Eio.Time.with_timeout_exn clock 2. operation with Eio.Time.Timeout -> ()

let reconcile_peer_subscription ~net ~clock (manager : Config.managed_workers)
    (subscription : Registry.peer_subscription) =
  match Registry.find_active manager.registry subscription.source_id with
  | None -> ()
  | Some source ->
      let requests = subscription_requests manager source subscription in
      Eio.Switch.run (fun sw ->
          requests
          |> List.filter (Fun.negate peer_request_finished)
          |> List.iter (fun request ->
              Eio.Fiber.fork ~sw (fun () ->
                  bounded_subscription_operation ~clock (fun () ->
                      ignore
                        (reconcile_peer_request ~net manager ~source request)))));
      let requests = subscription_requests manager source subscription in
      if peer_subscription_ready subscription requests then (
        Registry.mark_peer_subscription_dispatching manager.registry
          subscription.id;
        bounded_subscription_operation ~clock (fun () ->
            let socket =
              Lifecycle.session_socket manager.runtime_root source.id
            in
            match
              Result.bind
                (prompt_request ~net socket ~command_id:subscription.command_id
                   ~text:(peer_wake_prompt subscription requests))
                (worker_request ~net socket)
            with
            | Error _ -> ()
            | Ok _ ->
                ignore
                  (Registry.complete_peer_subscription manager.registry
                     subscription.id)))

let supervise ~net ~clock (manager : Config.managed_workers) =
  let supervise subscription =
    try reconcile_peer_subscription ~net ~clock manager subscription
    with exn ->
      Format.eprintf "peer subscription %s error: %s@." subscription.Registry.id
        (Printexc.to_string exn)
  in
  let rec loop () =
    Eio.Switch.run (fun sw ->
        Registry.list_open_peer_subscriptions manager.registry
        |> List.iter (fun subscription ->
            Eio.Fiber.fork ~sw (fun () -> supervise subscription)));
    Eio.Time.sleep clock 0.25;
    loop ()
  in
  loop ()
