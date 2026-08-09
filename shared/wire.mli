(* PISS wire protocol. The control plane and every session worker exchange
   JSON-RPC-like messages over a Unix-domain socket. The shapes are designed so
   that every field has a bounded length (no arbitrary blobs) and every variant
   has a clear `op` discriminator.

   Naming follows the Real World OCaml "Design with Modules" conventions: this
   module is named `Wire`, the primary types are `request` and `response`, the
   codec functions are named `request_of_yojson` and `response_to_yojson` /
   `response_of_yojson`, and every constant that limits a wire boundary is named
   `max_<thing>` so callers can find them in one place. *)

val max_prompt_images : int
(** Maximum number of images per prompt. *)

val max_prompt_image_bytes : int
(** Maximum total decoded byte size across all images in one prompt. *)

val supported_image_mime_types : string list
(** MIME types the worker accepts in a [Prompt]. Anything else is rejected at
    the wire boundary. *)

type request =
  | Hello of { protocol_version : int }
  | Snapshot
  | Prepare_upgrade of { generation : string }
  | Events of { after : int64; limit : int }
  | Events_before of { before : int64; limit : int }
  | Recent_events of { limit : int }
  | File_search of { query : string }
  | New_session
  | Prompt of {
      command_id : string;
      text : string;
      images : Domain.image_input list;
      resources : Domain.resource_input list;
    }
  | Deliver of {
      command_id : string;
      text : string;
      images : Domain.image_input list;
      resources : Domain.resource_input list;
      action : string;
    }
  | Cancel
  | Config_options
  | Set_config_option of { config_id : string; value : string }
  | Permission of { request_id : string; option_id : string option }
  | Peer_event of {
      kind : string;
      request_id : string;
      peer_id : string;
      text : string;
    }

type response = (Yojson.Safe.t, string) result
(** A response from the worker to the control plane. The `Ok` arm carries the
    worker-supplied payload (already JSON); the `Error` arm carries a
    human-readable diagnostic string. *)

val request_of_yojson : Yojson.Safe.t -> (request, string) result
val response_to_yojson : response -> Yojson.Safe.t
val response_of_yojson : Yojson.Safe.t -> response
val image_to_yojson : Domain.image_input -> Yojson.Safe.t
val image_metadata_to_yojson : Domain.image_input -> Yojson.Safe.t
val resource_to_yojson : Domain.resource_input -> Yojson.Safe.t

val validate_prompt :
  empty_message:string ->
  text:string ->
  images:Domain.image_input list ->
  resources:Domain.resource_input list ->
  (unit, string) result
(** Validate that a decoded prompt is non-empty and within size limits. The
    first arg is the message used when the prompt contains no text, images, or
    resources. *)
