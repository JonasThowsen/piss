open! Bonsai_web.Cont

type kind = Dialog | Alertdialog

val activate :
  surface_id:string ->
  initial_focus:string ->
  dismissible:bool ->
  on_close:(unit -> unit Effect.t) ->
  unit Effect.t

val deactivate : unit -> unit Effect.t
val set_dismissible : bool -> unit Effect.t
val cleanup : unit -> unit Effect.t

val surface :
  kind:kind ->
  surface_id:string ->
  labelled_by:string ->
  ?described_by:string ->
  class_name:string ->
  dismissible:bool ->
  on_close:(unit -> unit Effect.t) ->
  Vdom.Node.t list ->
  Vdom.Node.t
(** Accessible modal surface with safe backdrop dismissal. *)
