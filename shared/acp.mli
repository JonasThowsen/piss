(* ACP (Agent Client Protocol) v1 envelope helpers and message
   constructors. The worker drives an ACP harness over stdio JSON-RPC;
   the helpers here build the wire shapes the harness expects and
   decode the envelopes the harness sends back.

   Naming follows the Real World OCaml "Design with Modules"
   conventions: this module is named `Acp`, the primary type is
   `envelope`, the codec is `envelope_of_yojson`, and every wire
   message we construct is named `<verb>_<noun>_<shape>` (for
   example `new_session_request`). *)

(** The JSON-RPC `id` field. ACP allows string and integer ids; the
    worker always sends strings. *)
type request_id = string

(** One JSON-RPC envelope read from the harness. The discriminator
    is the presence of a `method` field (Notification or Request)
    vs. the absence of `method` with an `id` (Response). *)
type envelope =
  | Response of {
      id : request_id;
      result : Yojson.Safe.t option;
      error : Yojson.Safe.t option;
    }
  | Notification of { method_ : string; params : Yojson.Safe.t }
  | Request of { id : request_id; method_ : string; params : Yojson.Safe.t }

(** Decode a single JSON-RPC envelope. Returns [Error] only when the
    shape is so malformed that the envelope kind itself is unclear. *)
val envelope_of_yojson : Yojson.Safe.t -> (envelope, string) result

(** Best-effort decode of a JSON-RPC `id` field. The harness is
    allowed to send string or integer ids; the worker always sends
    strings. Returns [None] when the field is missing or has an
    unexpected type. *)
val id_to_string : Yojson.Safe.t -> string option

(** Inspect a JSON value that should be a response for a specific id.
    [Ok] carries the result payload, [Error] carries a human-readable
    diagnostic. *)
val response_result :
  expected_id:request_id -> Yojson.Safe.t -> (Yojson.Safe.t, string) result

(** Build a JSON-RPC request envelope. *)
val request : id:request_id -> method_:string -> Yojson.Safe.t -> Yojson.Safe.t

(** Build a JSON-RPC response envelope with a string id. *)
val response : id:request_id -> Yojson.Safe.t -> Yojson.Safe.t

(** Build a JSON-RPC response envelope with an arbitrary id (useful
    when echoing a non-string id back). *)
val response_with_id : id:Yojson.Safe.t -> Yojson.Safe.t -> Yojson.Safe.t

(** Build a JSON-RPC error response envelope. *)
val error_response_with_id :
  id:Yojson.Safe.t -> code:int -> message:string -> Yojson.Safe.t

(** Build a JSON-RPC notification envelope (no id). *)
val notification : method_:string -> Yojson.Safe.t -> Yojson.Safe.t

(** The first request the worker sends to the harness: protocol
    version, advertised capabilities, and the worker identity. *)
val initialize_request : Yojson.Safe.t

(** Build the `mcpServers` block carried by `session/new` and
    `session/load`. Empty [command] produces an empty list so the
    harness does not start a server we did not configure. *)
val mcp_servers :
  command:string ->
  session_id:string ->
  broker_url:string ->
  broker_token:string ->
  curl_command:string ->
  Yojson.Safe.t

(** `session/new` request. *)
val new_session_request :
  cwd:string ->
  session_id:string ->
  mcp_command:string ->
  broker_url:string ->
  broker_token:string ->
  curl_command:string ->
  Yojson.Safe.t

(** `session/load` request. *)
val load_session_request :
  session_id:string ->
  cwd:string ->
  piss_session_id:string ->
  mcp_command:string ->
  broker_url:string ->
  broker_token:string ->
  curl_command:string ->
  Yojson.Safe.t

(** `session/set_config_option` request. *)
val set_config_option_request :
  id:string ->
  session_id:string ->
  config_id:string ->
  value:string ->
  Yojson.Safe.t

(** `session/cancel` notification. *)
val cancel_notification : session_id:string -> Yojson.Safe.t

(** A single content block of type `image` for a session prompt. *)
val image_content : Domain.image_input -> Yojson.Safe.t

(** A single content block of type `resource_link` for a session
    prompt. *)
val resource_link_content : Workspace_files.resource -> Yojson.Safe.t

(** The full `session/prompt` request. [delivery] is [None] for an
    initial prompt and [Some action] for a steer or follow-up; the
    action is passed through `_meta.piss.delivery` so the harness
    can distinguish them. *)
val prompt_request :
  delivery:string option ->
  command_id:string ->
  session_id:string ->
  text:string ->
  images:Domain.image_input list ->
  resources:Workspace_files.resource list ->
  Yojson.Safe.t

(** Strip user-uploaded image data from a `session/update`
    notification whose `sessionUpdate` is `user_message_chunk`. The
    worker logs every such envelope to its durable ledger; the raw
    base64 payload is replaced with the empty string so the log
    never sees the user's bytes. Other envelope kinds are passed
    through unchanged. *)
val redact_user_image_data : Yojson.Safe.t -> Yojson.Safe.t
