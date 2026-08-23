type status =
  | Starting
  | Idle
  | Waiting
  | Running
  | Requires_action
  | Stopped
  | Failed
  | Offline
  | Archived

type choice = { value : string; name : string; description : string option }

type config_option = {
  config_id : string;
  category : string;
  name : string;
  description : string option;
  current_value : string;
  choices : choice list;
}

type t = {
  session_id : string;
  worker_id : string;
  worker_generation : string;
  runtime_generation : int;
  worker_pid : int;
  harness_pid : int option;
  agent_name : string;
  status : status;
  first_sequence : int64;
  last_sequence : int64;
  retention_pruned : bool;
  upgrade_pending : bool;
  accepts_images : bool;
  config_options : config_option list;
}

val status_to_string : status -> string
val status_label : status -> string
val decode : expected_session:string -> string -> (t, string) result

val decode_json :
  path:string -> expected_session:string -> Yojson.Safe.t -> (t, string) result

val decode_config_response : string -> (config_option list, string) result
val find_category : t -> string -> config_option option
val target_to_yojson : t -> Yojson.Safe.t

val mutation_to_yojson :
  t -> mutation_id:string -> (string * Yojson.Safe.t) list -> Yojson.Safe.t

val config_change_to_yojson :
  t -> mutation_id:string -> config_id:string -> value:string -> Yojson.Safe.t
