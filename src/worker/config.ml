(* Worker-side configuration: CLI parsing and shared constants. *)

let max_frame_bytes = 16 * 1024 * 1024
let max_event_page_bytes = 8 * 1024 * 1024

(* Same idea, but for permission requests the harness never resolves. A stale
   permission keeps `status = Requires_action` even though no command is in
   flight, which confuses the UI (it sees a "running" session that actually
   cannot accept a prompt) and pins the worker into a permanent steer-only
   state. Expire and reply with a `cancelled` outcome so the harness can move
   on. *)
let permission_timeout_seconds = 600.

type pending_permission = {
  raw_id : Yojson.Safe.t;
  params : Yojson.Safe.t;
  requested_at : float;
}

type args = {
  socket_path : string;
  database_path : string;
  session_id : string;
  worker_id : string;
  generation : string;
  workspace : string;
  harness_command : string;
  harness_args : string list;
  session_mcp : string;
  broker_url : string;
  broker_token : string;
  curl_command : string;
}

let parse () =
  let socket_path = ref "" in
  let database_path = ref "" in
  let session_id = ref "tracer-session" in
  let worker_id = ref "tracer-worker" in
  let generation = ref "development" in
  let workspace = ref (Sys.getcwd ()) in
  let harness_command = ref "piss-mock-agent" in
  let harness_args = ref [] in
  let session_mcp = ref "" in
  let broker_url = ref "http://127.0.0.1:4318" in
  let broker_token = ref "" in
  let curl_command = ref "curl" in
  Arg.parse
    [
      ("--socket", Arg.Set_string socket_path, "Worker Unix socket path");
      ("--database", Arg.Set_string database_path, "Worker SQLite database path");
      ("--session", Arg.Set_string session_id, "Piss session ID");
      ("--worker", Arg.Set_string worker_id, "Worker ID");
      ("--generation", Arg.Set_string generation, "Immutable worker generation");
      ("--workspace", Arg.Set_string workspace, "Authorized workspace");
      ( "--harness",
        Arg.Set_string harness_command,
        "Fixed ACP harness executable" );
      ( "--harness-arg",
        Arg.String (fun value -> harness_args := value :: !harness_args),
        "Fixed ACP harness argument (repeatable)" );
      ("--session-mcp", Arg.Set_string session_mcp, "Piss session MCP server");
      ("--broker-url", Arg.Set_string broker_url, "Loopback session broker URL");
      ("--broker-token", Arg.Set_string broker_token, "Session broker token");
      ("--curl-command", Arg.Set_string curl_command, "Fixed curl executable");
    ]
    (fun value -> raise (Arg.Bad ("unexpected argument: " ^ value)))
    "piss-session-worker";
  if !socket_path = "" then raise (Arg.Bad "--socket is required");
  if !database_path = "" then raise (Arg.Bad "--database is required");
  {
    socket_path = !socket_path;
    database_path = !database_path;
    session_id = !session_id;
    worker_id = !worker_id;
    generation = !generation;
    workspace = !workspace;
    harness_command = !harness_command;
    harness_args = List.rev !harness_args;
    session_mcp = !session_mcp;
    broker_url = !broker_url;
    broker_token = !broker_token;
    curl_command = !curl_command;
  }
