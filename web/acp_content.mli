type artifact =
  | Diff of { path : string; before : string; after : string }
  | Terminal of { terminal_id : string; text : string option }
  | Image of Image_attachment.t
  | Resource of { uri : string; name : string option; text : string option }
  | Location of { path : string; line : int option; text : string option }

val tool_content :
  path:string -> Yojson.Safe.t -> (string * artifact list, string) result

val locations :
  path:string -> (string * Yojson.Safe.t) list -> (artifact list, string) result

val equal : artifact -> artifact -> bool
val copy_text : artifact -> string
