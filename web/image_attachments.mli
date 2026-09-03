open! Bonsai_web.Cont

type output = {
  images : Image_attachment.t list;
  processing : bool;
  paste_attr : Vdom.Attr.t;
  previews : Vdom.Node.t;
  view : Vdom.Node.t;
  clear : unit -> unit Effect.t;
}

val component :
  available:bool Bonsai.t ->
  on_notice:(string -> unit Effect.t) Bonsai.t ->
  on_processing:(bool -> unit Effect.t) Bonsai.t ->
  composer_selection:(unit -> Image_references.selection) Bonsai.t ->
  on_images_added:
    (text:string ->
    start:int ->
    stop:int ->
    first_image_number:int ->
    count:int ->
    unit Effect.t)
    Bonsai.t ->
  on_image_removed:
    (removed_image_number:int -> image_count:int -> unit Effect.t) Bonsai.t ->
  Bonsai.graph ->
  output Bonsai.t
