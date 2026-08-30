open Bonsai_web.Cont

type t = { view : Vdom.Node.t; refresh : unit -> unit Vdom.Effect.t }

val component :
  session_id:string option Bonsai.t ->
  active:bool Bonsai.t ->
  runtime:Runtime_domain.t option Bonsai.t ->
  close:(unit -> unit Vdom.Effect.t) Bonsai.t ->
  submit_review_notes:
    (Prompt_command.action -> string -> unit Vdom.Effect.t) Bonsai.t ->
  Bonsai.graph ->
  t Bonsai.t
