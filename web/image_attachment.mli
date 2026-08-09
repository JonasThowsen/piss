type t

val max_count : int
val max_total_bytes : int
val supported_mime_types : string list

val of_data_url :
  name:string -> mime_type:string -> string -> (t, string) result

val validate_total : t list -> (unit, string) result
val mime_type : t -> string
val data : t -> string
val name : t -> string
val size : t -> int
val data_url : t -> string
