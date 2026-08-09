(** Effectful handling for routes available only in managed-worker mode. *)

val handle :
  net:_ Eio.Net.t ->
  clock:_ Eio.Time.clock ->
  manager:Config.managed_workers ->
  allowed_origins:string list ->
  dev_bypass:bool ->
  calling_session:Piss_core.Registry.session option ->
  request:Cohttp.Request.t ->
  read_body:(unit -> string) ->
  Routes.route ->
  Cohttp_eio.Server.response option
(** Handle a managed-only route, or return [None] so the caller can fall through
    to generic route handling. The body reader is invoked only after the route's
    authorization and content checks pass. *)
