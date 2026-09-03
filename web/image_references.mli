type selection = { text : string; start : int; stop : int }
(** A text selection in the composer that an image reference will replace. *)

val image_reference : int -> string
(** The stable text marker shown for an attached image. *)

val insert_image_references :
  selection -> first_image_number:int -> count:int -> selection
(** Insert consecutive image references at the captured composer selection. *)

val remove_image_reference :
  text:string -> removed_image_number:int -> image_count:int -> string
(** Remove one image marker and renumber the markers that followed it. *)
