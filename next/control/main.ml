open Piss_core

let max_body_bytes = 128 * 1024
let max_frame_bytes = 1024 * 1024
let default_max_active_sessions = 32

type managed_workers = {
  registry : Registry.t;
  state_root : string;
  runtime_root : string;
  launcher : string;
  stopper : string;
  available_harnesses : string list;
  default_harness : string;
  max_active_sessions : int;
}

type workers = Fixed of string | Managed of managed_workers

let security_headers =
  [
    ("cache-control", "no-store");
    ( "content-security-policy",
      "default-src 'self'; connect-src 'self'; font-src 'self'; img-src \
       'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; \
       base-uri 'none'; form-action 'none'" );
    ("referrer-policy", "no-referrer");
    ("x-content-type-options", "nosniff");
    ("x-frame-options", "DENY");
  ]

let json_headers =
  Http.Header.of_list
    (("content-type", "application/json; charset=utf-8") :: security_headers)

let text_headers content_type =
  Http.Header.of_list (("content-type", content_type) :: security_headers)

let event_stream_headers =
  Http.Header.of_list
    (("content-type", "text/event-stream; charset=utf-8")
    :: ("x-accel-buffering", "no")
    :: security_headers)

let respond_json ?(status = `OK) json =
  Cohttp_eio.Server.respond_string ~status ~headers:json_headers
    ~body:(Yojson.Safe.to_string json)
    ()

let error_json ?(status = `Bad_request) message =
  respond_json ~status (`Assoc [ ("error", `String message) ])

module Event_stream_source = struct
  type t = {
    fetch : int64 -> (Yojson.Safe.t list, string) result;
    sleep : float -> unit;
    mutable cursor : int64;
    mutable pending : string;
    mutable offset : int;
    mutable last_heartbeat : float;
  }

  let sequence event =
    match Yojson.Safe.Util.member "sequence" event with
    | `Int value -> Some (Int64.of_int value)
    | `Intlit value -> Int64.of_string_opt value
    | _ -> None

  let frame event =
    match sequence event with
    | None -> None
    | Some id ->
        Some
          ( id,
            Printf.sprintf "id: %Ld\ndata: %s\n\n" id
              (Yojson.Safe.to_string event) )

  let rec refill stream =
    match stream.fetch stream.cursor with
    | Error _ -> raise End_of_file
    | Ok events ->
        let frames = List.filter_map frame events in
        if List.length frames <> List.length events then raise End_of_file
        else if frames <> [] then (
          stream.cursor <-
            List.fold_left
              (fun cursor (id, _) -> Int64.max cursor id)
              stream.cursor frames;
          stream.pending <- frames |> List.map snd |> String.concat "";
          stream.offset <- 0)
        else if Unix.gettimeofday () -. stream.last_heartbeat >= 15. then (
          stream.pending <- ": keep-alive\n\n";
          stream.offset <- 0;
          stream.last_heartbeat <- Unix.gettimeofday ())
        else (
          stream.sleep 0.25;
          refill stream)

  let single_read stream target =
    if stream.offset >= String.length stream.pending then refill stream;
    let length =
      min (Cstruct.length target) (String.length stream.pending - stream.offset)
    in
    Cstruct.blit_from_string stream.pending stream.offset target 0 length;
    stream.offset <- stream.offset + length;
    length

  let read_methods = []
end

let event_stream_source ~fetch ~sleep ~after =
  let operations = Eio.Flow.Pi.source (module Event_stream_source) in
  Eio.Resource.T
    ( Event_stream_source.
        {
          fetch;
          sleep;
          cursor = after;
          pending = "retry: 1000\n\n";
          offset = 0;
          last_heartbeat = Unix.gettimeofday ();
        },
      operations )

let worker_request net socket_path request =
  Eio.Switch.run @@ fun sw ->
  let flow = Eio.Net.connect ~sw net (`Unix socket_path) in
  let reader = Eio.Buf_read.of_flow flow ~max_size:max_frame_bytes in
  let exchange request =
    Eio.Flow.copy_string (Yojson.Safe.to_string request ^ "\n") flow;
    Eio.Buf_read.line reader |> Yojson.Safe.from_string
    |> Wire.response_of_yojson
  in
  match
    exchange (`Assoc [ ("op", `String "hello"); ("protocolVersion", `Int 1) ])
  with
  | Error message -> Error ("worker negotiation failed: " ^ message)
  | Ok hello -> (
      match Yojson.Safe.Util.member "protocolVersion" hello with
      | `Int 1 -> exchange request
      | _ -> Error "worker selected an unsupported protocol version")

let rec mkdir_p path =
  if path <> "" && path <> Filename.dirname path && not (Sys.file_exists path)
  then (
    mkdir_p (Filename.dirname path);
    Unix.mkdir path 0o700)

let valid_session_id value =
  let valid_character = function
    | 'a' .. 'z' | '0' .. '9' | '-' -> true
    | _ -> false
  in
  String.length value >= 3
  && String.length value <= 64
  && String.for_all valid_character value

let random_session_id () =
  let channel = open_in_bin "/dev/urandom" in
  let bytes =
    Fun.protect
      ~finally:(fun () -> close_in_noerr channel)
      (fun () -> really_input_string channel 16)
  in
  let buffer = Buffer.create 34 in
  Buffer.add_string buffer "s-";
  String.iter
    (fun byte ->
      Buffer.add_string buffer (Printf.sprintf "%02x" (Char.code byte)))
    bytes;
  Buffer.contents buffer

let session_socket manager session_id =
  Filename.concat
    (Filename.concat manager.runtime_root session_id)
    "worker.sock"

let write_private_file path contents =
  let temporary = path ^ ".tmp" in
  let channel = open_out_bin temporary in
  Fun.protect
    ~finally:(fun () -> close_out_noerr channel)
    (fun () -> output_string channel contents);
  Unix.chmod temporary 0o600;
  Unix.rename temporary path

let write_session_spec manager (session : Registry.session) =
  let directory = Filename.concat manager.state_root session.id in
  mkdir_p directory;
  write_private_file
    (Filename.concat directory "harness")
    (session.harness ^ "\n");
  write_private_file
    (Filename.concat directory "broker-token")
    (session.broker_token ^ "\n")

let run_lifecycle executable session_id =
  if not (valid_session_id session_id) then Error "invalid session identity"
  else
    try
      let pid =
        Unix.create_process executable
          [| executable; session_id |]
          Unix.stdin Unix.stdout Unix.stderr
      in
      match snd (Unix.waitpid [] pid) with
      | Unix.WEXITED 0 -> Ok ()
      | Unix.WEXITED code ->
          Error
            (Printf.sprintf "session lifecycle command exited with status %d"
               code)
      | Unix.WSIGNALED signal | Unix.WSTOPPED signal ->
          Error
            (Printf.sprintf "session lifecycle command received signal %d"
               signal)
    with exn -> Error (Printexc.to_string exn)

let active_session manager requested =
  let selected =
    match requested with
    | Some id when valid_session_id id ->
        Registry.find_active manager.registry id
    | Some _ -> None
    | None ->
        List.nth_opt (Registry.list manager.registry ~include_archived:false) 0
  in
  match selected with
  | Some session -> Ok session
  | None -> Error "active session not found"

let worker_socket workers uri =
  match workers with
  | Fixed path -> Ok path
  | Managed manager ->
      let requested = Uri.get_query_param uri "session" in
      Result.map
        (fun (session : Registry.session) -> session_socket manager session.id)
        (active_session manager requested)

let with_worker workers uri operation =
  match worker_socket workers uri with
  | Ok socket -> operation socket
  | Error message -> Error message

let session_summary net manager (session : Registry.session) =
  let runtime =
    try
      match
        worker_request net
          (session_socket manager session.id)
          (`Assoc [ ("op", `String "snapshot") ])
      with
      | Ok (`Assoc fields) -> fields
      | Ok _ -> []
      | Error _ -> [ ("status", `String "offline") ]
    with _ -> [ ("status", `String "offline") ]
  in
  match Registry.session_to_yojson session with
  | `Assoc fields -> `Assoc (fields @ runtime)
  | _ -> assert false

let create_managed_session manager harness =
  if not (List.exists (String.equal harness) manager.available_harnesses) then
    Error "requested harness is not available"
  else if Registry.active_count manager.registry >= manager.max_active_sessions
  then Error "active session limit reached"
  else
    let id = random_session_id () in
    let title =
      (if String.equal harness "opencode" then "OpenCode" else "Pi")
      ^ " / " ^ String.sub id 2 8
    in
    let session = Registry.insert manager.registry ~id ~title ~harness in
    try
      write_session_spec manager session;
      match run_lifecycle manager.launcher id with
      | Ok () -> Ok session
      | Error message ->
          ignore (Registry.archive manager.registry id);
          Error message
    with exn ->
      ignore (Registry.archive manager.registry id);
      Error (Printexc.to_string exn)

let archive_managed_session manager id =
  if Registry.active_count manager.registry <= 1 then
    Error "at least one active session must remain"
  else
    match Registry.find_active manager.registry id with
    | None -> Error "active session not found"
    | Some _ -> (
        match run_lifecycle manager.stopper id with
        | Error message -> Error message
        | Ok () ->
            if Registry.archive manager.registry id then Ok ()
            else Error "session was already archived")

let restore_managed_session manager id =
  (* TODO(tracer): Persist started/completed lifecycle receipts before replacing
     the local synchronous systemd launcher with a remote or queued launcher. *)
  match Registry.find manager.registry id with
  | None -> Error "archived session not found"
  | Some { archived_at = None; _ } -> Error "session is already active"
  | Some session -> (
      if Registry.active_count manager.registry >= manager.max_active_sessions
      then Error "active session limit reached"
      else if not (Registry.restore manager.registry id) then
        Error "session could not be restored"
      else
        try
          write_session_spec manager { session with archived_at = None };
          match run_lifecycle manager.launcher id with
          | Ok () -> Ok ()
          | Error message ->
              ignore (Registry.archive manager.registry id);
              Error message
        with exn ->
          ignore (Registry.archive manager.registry id);
          Error (Printexc.to_string exn))

type session_action = Archive of string | Restore of string

let session_action path =
  match String.split_on_char '/' path with
  | [ ""; "api"; "v2"; "sessions"; id; "archive" ] when valid_session_id id ->
      Some (Archive id)
  | [ ""; "api"; "v2"; "sessions"; id; "restore" ] when valid_session_id id ->
      Some (Restore id)
  | _ -> None

let parse_non_negative_cursor value =
  match Int64.of_string_opt value with
  | Some cursor when cursor >= 0L -> Ok cursor
  | _ -> Error "event cursor must be a non-negative integer"

let parse_after uri =
  match Uri.get_query_param uri "after" with
  | None -> Ok 0L
  | Some value -> parse_non_negative_cursor value

let stream_after request uri =
  match parse_after uri with
  | Error _ as error -> error
  | Ok query_cursor -> (
      match Http.Header.get (Http.Request.headers request) "last-event-id" with
      | None | Some "" -> Ok query_cursor
      | Some value -> (
          match parse_non_negative_cursor value with
          | Error _ as error -> error
          | Ok header_cursor -> Ok (Int64.max query_cursor header_cursor)))

let parse_limit value =
  try
    let limit = int_of_string value in
    if limit < 1 || limit > 500 then Error "limit must be between 1 and 500"
    else Ok limit
  with Failure _ -> Error "limit must be an integer"

let read_body body =
  Eio.Buf_read.of_flow body ~max_size:max_body_bytes |> Eio.Buf_read.take_all

let request_header request name =
  Http.Header.get (Http.Request.headers request) name

let authorized ~allowed_users ~dev_bypass request =
  dev_bypass
  ||
  match request_header request "tailscale-user-login" with
  | Some login -> List.exists (String.equal login) allowed_users
  | None -> false

let valid_json_content request =
  match request_header request "content-type" with
  | Some content_type
    when String.starts_with ~prefix:"application/json" content_type ->
      Ok ()
  | _ -> Error (`Unsupported_media_type, "content-type must be application/json")

let valid_json_mutation ~dev_bypass request =
  if dev_bypass then Ok ()
  else
    match valid_json_content request with
    | Error _ as error -> error
    | Ok () -> (
        match
          (request_header request "origin", request_header request "host")
        with
        | Some origin, Some host
          when String.equal origin ("https://" ^ host)
               || String.equal origin ("http://" ^ host) ->
            Ok ()
        | _ -> Error (`Forbidden, "same-origin mutation required"))

let safe_asset_path root resource =
  match resource with
  | "/" -> Some (Filename.concat root "index.html", "text/html; charset=utf-8")
  | "/styles.css" ->
      Some (Filename.concat root "styles.css", "text/css; charset=utf-8")
  | resource when String.starts_with ~prefix:"/fonts/" resource ->
      let name = Filename.basename resource in
      if
        name = resource || String.contains name '/' || String.contains name '\\'
      then None
      else
        let content_type =
          if Filename.extension name = ".ttf" then "font/ttf"
          else "text/plain; charset=utf-8"
        in
        Some (Filename.concat (Filename.concat root "fonts") name, content_type)
  | _ -> None

let peer_event net manager (session : Registry.session) ~kind ~request_id
    ~peer_id ~text =
  worker_request net
    (session_socket manager session.id)
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
  if member "kind" event <> `String "command.state" then None
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

type peer_observation =
  | Peer_pending
  | Peer_completed of string
  | Peer_failed of string

let is_command_accepted command_id event =
  let open Yojson.Safe.Util in
  if member "kind" event <> `String "command.accepted" then false
  else member "commandId" (member "payload" event) = `String command_id

let inspect_peer_response ~net ~socket (request : Registry.peer_request) =
  let rec pages cursor chunks command_seen =
    match
      worker_request net socket
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
        let command_seen, chunks =
          List.fold_left
            (fun (seen, collected) event ->
              let seen = seen || is_command_accepted request.command_id event in
              let text = if seen then agent_chunk_text event else "" in
              (seen, if text = "" then collected else text :: collected))
            (command_seen, chunks) events
        in
        let terminal =
          List.find_map (command_terminal_state request.command_id) events
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

let target_sequence net manager (target : Registry.session) =
  match
    worker_request net
      (session_socket manager target.id)
      (`Assoc [ ("op", `String "snapshot") ])
  with
  | Ok snapshot -> (
      match Yojson.Safe.Util.member "lastSequence" snapshot with
      | `Int value -> Int64.of_int value
      | `Intlit value -> Option.value ~default:0L (Int64.of_string_opt value)
      | _ -> 0L)
  | Error _ -> 0L

let dispatch_peer_request ~net manager ~(source : Registry.session)
    ~(target : Registry.session) (request : Registry.peer_request) =
  if String.equal request.state "completed" then Ok request
  else
    let was_new = String.equal request.state "accepted" in
    let request, dispatch_transition =
      if List.mem request.state [ "accepted"; "queued" ] then (
        Registry.mark_peer_dispatching manager.registry request.id
          ~start_sequence:(target_sequence net manager target);
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
    match
      worker_request net
        (session_socket manager target.id)
        (`Assoc
           [
             ("op", `String "prompt");
             ("commandId", `String request.command_id);
             ("text", `String target_prompt);
           ])
    with
    | Error message ->
        Registry.update_peer_request manager.registry request.id ~state:"queued"
          ~response:None;
        if was_new then
          ignore
            (peer_event net manager source ~kind:"session.ask.queued"
               ~request_id:request.id ~peer_id:target.id ~text:request.prompt);
        Error message
    | Ok _ ->
        Registry.update_peer_request manager.registry request.id
          ~state:"dispatched" ~response:None;
        if dispatch_transition then (
          ignore
            (peer_event net manager source ~kind:"session.ask.dispatched"
               ~request_id:request.id ~peer_id:target.id ~text:request.prompt);
          ignore
            (peer_event net manager target ~kind:"session.ask.received"
               ~request_id:request.id ~peer_id:source.id ~text:request.prompt));
        Ok (Option.get (Registry.find_peer_request manager.registry request.id))

let complete_peer_observation ~net manager ~(source : Registry.session)
    (request : Registry.peer_request) observation =
  match observation with
  | Peer_completed response ->
      if Registry.complete_peer_request manager.registry request.id response
      then
        ignore
          (peer_event net manager source ~kind:"session.ask.completed"
             ~request_id:request.id ~peer_id:request.target_id ~text:response);
      Peer_completed response
  | Peer_failed message ->
      Registry.update_peer_request manager.registry request.id ~state:"failed"
        ~response:(Some message);
      ignore
        (peer_event net manager source ~kind:"session.ask.failed"
           ~request_id:request.id ~peer_id:request.target_id ~text:message);
      Peer_failed message
  | observation -> observation

let reconcile_peer_request ~net manager ~(source : Registry.session)
    (request : Registry.peer_request) =
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
                ~socket:(session_socket manager target.id)
                dispatched
              |> complete_peer_observation ~net manager ~source dispatched))

let wait_for_peer_response ~net ~clock manager ~(source : Registry.session)
    request =
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

let accept_peer_json ~net manager ~(source : Registry.session) json =
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
              (peer_event net manager source ~kind:"session.ask.sent"
                 ~request_id ~peer_id:target.id ~text:prompt);
            Ok (request, false))

let send_peer_request ~net manager ~(source : Registry.session) json =
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

let collect_peer_requests ~net ~clock manager ~(source : Registry.session)
    ~request_ids ~wait_for ~timeout =
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

let broker_source workers request =
  match workers with
  | Fixed _ -> None
  | Managed manager -> (
      match request_header request "x-piss-session-token" with
      | Some token -> Registry.find_active_by_token manager.registry token
      | None -> None)

let serve_asset path content_type =
  try
    let channel = open_in_bin path in
    let body =
      Fun.protect
        ~finally:(fun () -> close_in_noerr channel)
        (fun () -> really_input_string channel (in_channel_length channel))
    in
    Cohttp_eio.Server.respond_string ~status:`OK
      ~headers:(text_headers content_type)
      ~body ()
  with Sys_error _ -> error_json ~status:`Not_found "asset not found"

let handler ~net ~clock ~workers ~public_dir ~app_js ~generation ~allowed_users
    ~dev_bypass _socket request body =
  let resource = Http.Request.resource request in
  let uri = Uri.of_string resource in
  let path = Uri.path uri in
  let method_ = Http.Request.meth request in
  try
    let calling_session = broker_source workers request in
    let is_broker_path = String.starts_with ~prefix:"/api/v2/broker/" path in
    if
      (not (String.equal path "/health"))
      && Option.is_none calling_session
      && not (authorized ~allowed_users ~dev_bypass request)
    then
      error_json ~status:`Unauthorized
        (if is_broker_path then "session broker token is not authorized"
         else "Tailscale identity is not authorized")
    else
      let managed_response =
        match (workers, method_, path, session_action path) with
        | Managed manager, `GET, "/api/v2/broker/sessions", _ ->
            Some
              (match calling_session with
              | None -> error_json ~status:`Unauthorized "broker token required"
              | Some caller ->
                  Registry.list manager.registry ~include_archived:false
                  |> List.map (fun (session : Registry.session) ->
                      `Assoc
                        [
                          ("id", `String session.Registry.id);
                          ("title", `String session.title);
                          ("harness", `String session.harness);
                          ("self", `Bool (String.equal caller.id session.id));
                        ])
                  |> fun sessions -> respond_json (`List sessions))
        | Managed manager, `POST, "/api/v2/broker/send", _ ->
            Some
              (match calling_session with
              | None -> error_json ~status:`Unauthorized "broker token required"
              | Some source -> (
                  match valid_json_content request with
                  | Error (status, message) -> error_json ~status message
                  | Ok () -> (
                      let json = read_body body |> Yojson.Safe.from_string in
                      match send_peer_request ~net manager ~source json with
                      | Error message -> error_json ~status:`Conflict message
                      | Ok (peer_request, duplicate) ->
                          respond_json ~status:`Accepted
                            (`Assoc
                               [
                                 ("requestId", `String peer_request.id);
                                 ("state", `String peer_request.state);
                                 ("duplicate", `Bool duplicate);
                               ]))))
        | Managed manager, `POST, "/api/v2/broker/ask", _ ->
            Some
              (match calling_session with
              | None -> error_json ~status:`Unauthorized "broker token required"
              | Some source -> (
                  match valid_json_content request with
                  | Error (status, message) -> error_json ~status message
                  | Ok () -> (
                      let json = read_body body |> Yojson.Safe.from_string in
                      match send_peer_request ~net manager ~source json with
                      | Error message -> error_json ~status:`Conflict message
                      | Ok (peer_request, duplicate) -> (
                          match
                            wait_for_peer_response ~net ~clock manager ~source
                              peer_request
                          with
                          | Error message ->
                              error_json ~status:`Service_unavailable message
                          | Ok response ->
                              respond_json
                                (`Assoc
                                   [
                                     ("requestId", `String peer_request.id);
                                     ("response", `String response);
                                     ("duplicate", `Bool duplicate);
                                   ])))))
        | Managed manager, `POST, "/api/v2/broker/collect", _ ->
            Some
              (match calling_session with
              | None -> error_json ~status:`Unauthorized "broker token required"
              | Some source -> (
                  match valid_json_content request with
                  | Error (status, message) -> error_json ~status message
                  | Ok () ->
                      let json = read_body body |> Yojson.Safe.from_string in
                      let open Yojson.Safe.Util in
                      let request_ids =
                        json |> member "requestIds" |> to_list
                        |> List.map to_string
                        |> List.sort_uniq String.compare
                      in
                      let wait_for =
                        match member "waitFor" json with
                        | `String value -> value
                        | _ -> "all"
                      in
                      let timeout =
                        match member "timeoutSeconds" json with
                        | `Int value -> float_of_int value
                        | `Float value -> value
                        | _ -> 600.
                      in
                      if request_ids = [] || List.length request_ids > 64 then
                        error_json
                          "requestIds must contain between 1 and 64 identities"
                      else if timeout < 0. || timeout > 600. then
                        error_json "timeoutSeconds must be between 0 and 600"
                      else if not (List.mem wait_for [ "any"; "all" ]) then
                        error_json "waitFor must be 'any' or 'all'"
                      else
                        let finished, pending =
                          collect_peer_requests ~net ~clock manager ~source
                            ~request_ids ~wait_for ~timeout
                        in
                        respond_json
                          (`Assoc
                             [
                               ( "responses",
                                 `List (List.map peer_request_json finished) );
                               ( "pendingRequestIds",
                                 `List
                                   (List.map
                                      (fun request ->
                                        `String request.Registry.id)
                                      pending) );
                             ])))
        | Managed manager, `GET, "/api/v2/sessions", _ ->
            let sessions =
              match Uri.get_query_param uri "archived" with
              | Some "true" ->
                  Registry.list_archived manager.registry
                  |> List.map (fun session ->
                      match Registry.session_to_yojson session with
                      | `Assoc fields ->
                          `Assoc (("status", `String "archived") :: fields)
                      | _ -> assert false)
              | _ ->
                  Registry.list manager.registry ~include_archived:false
                  |> List.map (session_summary net manager)
            in
            Some (respond_json (`List sessions))
        | Managed manager, `POST, "/api/v2/sessions", _ ->
            Some
              (match valid_json_mutation ~dev_bypass request with
              | Error (status, message) -> error_json ~status message
              | Ok () -> (
                  let json = read_body body |> Yojson.Safe.from_string in
                  let harness =
                    match Yojson.Safe.Util.member "harness" json with
                    | `String value -> value
                    | _ -> manager.default_harness
                  in
                  match create_managed_session manager harness with
                  | Ok session ->
                      respond_json ~status:`Created
                        (Registry.session_to_yojson session)
                  | Error message -> error_json ~status:`Conflict message))
        | Managed manager, `POST, _, Some action ->
            Some
              (match valid_json_mutation ~dev_bypass request with
              | Error (status, message) -> error_json ~status message
              | Ok () -> (
                  ignore (read_body body);
                  match action with
                  | Archive id -> (
                      match archive_managed_session manager id with
                      | Ok () ->
                          respond_json (`Assoc [ ("archived", `Bool true) ])
                      | Error message -> error_json ~status:`Conflict message)
                  | Restore id -> (
                      match restore_managed_session manager id with
                      | Ok () ->
                          respond_json (`Assoc [ ("restored", `Bool true) ])
                      | Error message -> error_json ~status:`Conflict message)))
        | _ -> None
      in
      match managed_response with
      | Some response -> response
      | None -> (
          match (method_, path) with
          | `GET, "/health" ->
              respond_json
                (`Assoc
                   [
                     ("status", `String "ok");
                     ("generation", `String generation);
                     ("pid", `Int (Unix.getpid ()));
                   ])
          | `GET, "/api/v2/session" -> (
              match
                with_worker workers uri (fun socket ->
                    worker_request net socket
                      (`Assoc [ ("op", `String "snapshot") ]))
              with
              | Ok snapshot -> respond_json snapshot
              | Error message -> error_json ~status:`Service_unavailable message
              )
          | `GET, "/api/v2/event-stream" -> (
              match stream_after request uri with
              | Error message -> error_json message
              | Ok after -> (
                  match worker_socket workers uri with
                  | Error message ->
                      error_json ~status:`Service_unavailable message
                  | Ok socket ->
                      (* TODO(tracer): Add a worker-side wait_events primitive
                         before supporting many concurrent observers per
                         session; this first browser stream uses bounded 250 ms
                         reads. *)
                      let fetch cursor =
                        match
                          worker_request net socket
                            (`Assoc
                               [
                                 ("op", `String "events");
                                 ("after", `Intlit (Int64.to_string cursor));
                                 ("limit", `Int 200);
                               ])
                        with
                        | Ok (`List events) -> Ok events
                        | Ok _ -> Error "worker returned an invalid event page"
                        | Error message -> Error message
                      in
                      let stream =
                        event_stream_source ~fetch ~after
                          ~sleep:(Eio.Time.sleep clock)
                      in
                      Cohttp_eio.Server.respond ~status:`OK
                        ~headers:event_stream_headers ~body:stream ()))
          | `GET, "/api/v2/events" -> (
              let request =
                match Uri.get_query_param uri "recent" with
                | Some value -> (
                    match parse_limit value with
                    | Ok limit ->
                        Ok
                          (`Assoc
                             [
                               ("op", `String "recent_events");
                               ("limit", `Int limit);
                             ])
                    | Error message -> Error message)
                | None -> (
                    match parse_after uri with
                    | Ok after ->
                        Ok
                          (`Assoc
                             [
                               ("op", `String "events");
                               ("after", `Intlit (Int64.to_string after));
                               ("limit", `Int 200);
                             ])
                    | Error message -> Error message)
              in
              match request with
              | Error message -> error_json message
              | Ok request -> (
                  match
                    with_worker workers uri (fun socket ->
                        worker_request net socket request)
                  with
                  | Ok events -> respond_json events
                  | Error message ->
                      error_json ~status:`Service_unavailable message))
          | `POST, "/api/v2/session/new" -> (
              match valid_json_mutation ~dev_bypass request with
              | Error (status, message) -> error_json ~status message
              | Ok () -> (
                  ignore (read_body body);
                  match workers with
                  | Managed manager -> (
                      match
                        create_managed_session manager manager.default_harness
                      with
                      | Ok session ->
                          respond_json ~status:`Created
                            (Registry.session_to_yojson session)
                      | Error message -> error_json ~status:`Conflict message)
                  | Fixed socket -> (
                      match
                        worker_request net socket
                          (`Assoc [ ("op", `String "new_session") ])
                      with
                      | Ok result -> respond_json ~status:`Created result
                      | Error message -> error_json ~status:`Conflict message)))
          | `POST, "/api/v2/commands" -> (
              match valid_json_mutation ~dev_bypass request with
              | Error (status, message) -> error_json ~status message
              | Ok () -> (
                  let json = read_body body |> Yojson.Safe.from_string in
                  let open Yojson.Safe.Util in
                  let command_id = json |> member "commandId" |> to_string in
                  let text = json |> member "text" |> to_string in
                  if command_id = "" || String.length command_id > 128 then
                    error_json
                      "commandId must contain between 1 and 128 characters"
                  else if text = "" || String.length text > 64 * 1024 then
                    error_json
                      "text must contain between 1 and 65536 characters"
                  else
                    match
                      with_worker workers uri (fun socket ->
                          worker_request net socket
                            (`Assoc
                               [
                                 ("op", `String "prompt");
                                 ("commandId", `String command_id);
                                 ("text", `String text);
                               ]))
                    with
                    | Ok result -> respond_json ~status:`Accepted result
                    | Error message ->
                        error_json ~status:`Service_unavailable message))
          | `POST, "/api/v2/cancel" -> (
              match valid_json_mutation ~dev_bypass request with
              | Error (status, message) -> error_json ~status message
              | Ok () -> (
                  ignore (read_body body);
                  match
                    with_worker workers uri (fun socket ->
                        worker_request net socket
                          (`Assoc [ ("op", `String "cancel") ]))
                  with
                  | Ok result -> respond_json ~status:`Accepted result
                  | Error message -> error_json ~status:`Conflict message))
          | `POST, "/api/v2/permissions" -> (
              match valid_json_mutation ~dev_bypass request with
              | Error (status, message) -> error_json ~status message
              | Ok () -> (
                  let json = read_body body |> Yojson.Safe.from_string in
                  let open Yojson.Safe.Util in
                  let request_id = json |> member "requestId" |> to_string in
                  let option_id =
                    match member "optionId" json with
                    | `String value -> `String value
                    | `Null -> `Null
                    | _ ->
                        raise
                          (Type_error ("optionId must be a string or null", json))
                  in
                  match
                    with_worker workers uri (fun socket ->
                        worker_request net socket
                          (`Assoc
                             [
                               ("op", `String "permission");
                               ("requestId", `String request_id);
                               ("optionId", option_id);
                             ]))
                  with
                  | Ok result -> respond_json result
                  | Error message -> error_json ~status:`Conflict message))
          | `GET, "/app.js" ->
              serve_asset app_js "text/javascript; charset=utf-8"
          | `GET, resource -> (
              match safe_asset_path public_dir resource with
              | Some (path, content_type) -> serve_asset path content_type
              | None -> error_json ~status:`Not_found "not found")
          | _ ->
              let method_name =
                match method_ with
                | `GET -> "GET"
                | `POST -> "POST"
                | `PUT -> "PUT"
                | `DELETE -> "DELETE"
                | `PATCH -> "PATCH"
                | `HEAD -> "HEAD"
                | `OPTIONS -> "OPTIONS"
                | `CONNECT -> "CONNECT"
                | `TRACE -> "TRACE"
                | `Other value -> value
              in
              error_json ~status:`Method_not_allowed
                (method_name ^ " not allowed for " ^ path))
  with
  | Eio.Io _ as exn ->
      error_json ~status:`Service_unavailable (Printexc.to_string exn)
  | Eio.Buf_read.Buffer_limit_exceeded ->
      error_json ~status:`Request_entity_too_large "request body is too large"
  | Yojson.Json_error message -> error_json ("invalid JSON: " ^ message)
  | Yojson.Safe.Util.Type_error (message, _) -> error_json message
  | Invalid_argument message -> error_json message
  | exn -> error_json ~status:`Internal_server_error (Printexc.to_string exn)

let () =
  let port = ref 4318 in
  let worker_socket_path = ref "" in
  let registry_path = ref "" in
  let session_state_root = ref "" in
  let session_runtime_root = ref "" in
  let session_launcher = ref "" in
  let session_stopper = ref "" in
  let available_harnesses = ref [] in
  let default_harness = ref "pi" in
  let bootstrap_session = ref "deployed-tracer" in
  let max_active_sessions = ref default_max_active_sessions in
  let public_dir = ref "web-next/public" in
  let app_js = ref "_build/default/web-next/app.js" in
  let generation = ref "development" in
  let allowed_users = ref [] in
  let dev_bypass = ref false in
  Arg.parse
    [
      ("--port", Arg.Set_int port, "Loopback HTTP port");
      ( "--worker-socket",
        Arg.Set_string worker_socket_path,
        "Single worker socket (development compatibility mode)" );
      ("--registry", Arg.Set_string registry_path, "Durable session registry");
      ( "--session-state-root",
        Arg.Set_string session_state_root,
        "Durable per-session state directory" );
      ( "--session-runtime-root",
        Arg.Set_string session_runtime_root,
        "Per-session socket directory" );
      ( "--session-launcher",
        Arg.Set_string session_launcher,
        "Fixed executable used to start a session worker" );
      ( "--session-stopper",
        Arg.Set_string session_stopper,
        "Fixed executable used to stop a session worker" );
      ( "--available-harness",
        Arg.String
          (fun value -> available_harnesses := value :: !available_harnesses),
        "Allowed harness identifier (repeatable)" );
      ( "--default-harness",
        Arg.Set_string default_harness,
        "Harness used by compatibility creation" );
      ( "--bootstrap-session",
        Arg.Set_string bootstrap_session,
        "Initial session identity for an empty registry" );
      ( "--max-active-sessions",
        Arg.Set_int max_active_sessions,
        "Configured active session resource limit" );
      ("--public", Arg.Set_string public_dir, "Browser public directory");
      ("--app-js", Arg.Set_string app_js, "Melange application module");
      ( "--generation",
        Arg.Set_string generation,
        "Immutable control-plane generation" );
      ( "--allowed-user",
        Arg.String (fun value -> allowed_users := value :: !allowed_users),
        "Authorized Tailscale login (repeatable)" );
      ( "--dev-bypass-auth",
        Arg.Set dev_bypass,
        "Allow loopback development requests without Tailscale headers" );
    ]
    (fun value -> raise (Arg.Bad ("unexpected argument: " ^ value)))
    "pissd-next";
  if !allowed_users = [] && not !dev_bypass then
    raise (Arg.Bad "at least one --allowed-user is required");
  if !max_active_sessions < 1 || !max_active_sessions > 256 then
    raise (Arg.Bad "--max-active-sessions must be between 1 and 256");
  let managed_arguments =
    [
      !registry_path;
      !session_state_root;
      !session_runtime_root;
      !session_launcher;
      !session_stopper;
    ]
  in
  let workers, close_registry =
    if !worker_socket_path <> "" then (Fixed !worker_socket_path, fun () -> ())
    else if List.for_all (fun value -> value <> "") managed_arguments then (
      mkdir_p (Filename.dirname !registry_path);
      mkdir_p !session_state_root;
      let registry = Registry.open_ ~path:!registry_path in
      let available = List.rev !available_harnesses in
      if available = [] then raise (Arg.Bad "--available-harness is required");
      if not (List.exists (String.equal !default_harness) available) then
        raise (Arg.Bad "--default-harness must be available");
      let manager =
        {
          registry;
          state_root = !session_state_root;
          runtime_root = !session_runtime_root;
          launcher = !session_launcher;
          stopper = !session_stopper;
          available_harnesses = available;
          default_harness = !default_harness;
          max_active_sessions = !max_active_sessions;
        }
      in
      if Registry.active_count registry = 0 then
        ignore
          (Registry.insert registry ~id:!bootstrap_session
             ~title:"Pi / deployed" ~harness:!default_harness);
      Registry.list registry ~include_archived:false
      |> List.iter (fun session ->
          write_session_spec manager session;
          match run_lifecycle manager.launcher session.id with
          | Ok () -> ()
          | Error message ->
              Format.eprintf "could not start session %s: %s@." session.id
                message);
      (Managed manager, fun () -> Registry.close registry))
    else
      raise
        (Arg.Bad
           "provide --worker-socket or the complete managed-session argument \
            set")
  in
  Fun.protect ~finally:close_registry @@ fun () ->
  Eio_main.run @@ fun env ->
  Eio.Switch.run @@ fun sw ->
  let socket =
    Eio.Net.listen (Eio.Stdenv.net env) ~sw ~backlog:128 ~reuse_addr:true
      (`Tcp (Eio.Net.Ipaddr.V4.loopback, !port))
  in
  let callback =
    handler ~net:(Eio.Stdenv.net env) ~clock:(Eio.Stdenv.clock env) ~workers
      ~public_dir:!public_dir ~app_js:!app_js ~generation:!generation
      ~allowed_users:!allowed_users ~dev_bypass:!dev_bypass
  in
  let server = Cohttp_eio.Server.make ~callback () in
  Printf.printf "control_ready generation=%s pid=%d url=http://127.0.0.1:%d\n%!"
    !generation (Unix.getpid ()) !port;
  Cohttp_eio.Server.run socket server ~on_error:(fun exn ->
      Format.eprintf "HTTP error: %a@." Eio.Exn.pp exn)
