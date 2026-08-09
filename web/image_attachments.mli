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
  Bonsai.graph ->
  output Bonsai.t
