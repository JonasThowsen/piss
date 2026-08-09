type t
type token = int

type action =
  | Begin of token
  | Complete of token * (Image_attachment.t list, string) result
  | Clear
  | Remove of int

val empty : t
val next_token : t -> token
val apply : t -> action -> t
val images : t -> Image_attachment.t list
val processing : t -> bool
val notification : t -> (int * string) option
