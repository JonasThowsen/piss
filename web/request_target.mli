val same_origin :
  path:string -> query:(string * string) list -> (string, string) result

(** Builds an encoded absolute-path request target and rejects authority,
    scheme, and fragment components. *)
