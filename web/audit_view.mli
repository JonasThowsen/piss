open Bonsai_web.Cont

type t = { view : Vdom.Node.t; refresh : unit -> unit Vdom.Effect.t }

val component :
  session_id:string option Bonsai.t ->
  active:bool Bonsai.t ->
  Bonsai.graph ->
  t Bonsai.t
