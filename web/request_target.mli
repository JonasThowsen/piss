val same_origin :
  path:string -> query:(string * string) list -> (string, string) result

val path_with_id : prefix:string -> id:string -> suffix:string -> string
(** Encodes an untrusted identifier as one URL path segment. *)

(** Builds an encoded absolute-path request target and rejects authority,
    scheme, and fragment components. *)
