type t
type resource = { path : string }
type image = { mime_type : string; data : string; name : string }
type action = Prompt | Steer | Follow_up

module Submission : sig
  type 'a t = Ready | Sending of 'a | Uncertain of 'a

  val ready : 'a t
  val start : 'a -> 'a t
  val mark_uncertain : 'a t -> 'a t
  val retry : 'a t -> 'a t
  val abandon : 'a t -> 'a t
  val pending : 'a t -> 'a option
  val is_sending : 'a t -> bool
end

val action_to_string : action -> string
val action_of_string : string -> (action, string) result

val create :
  runtime:Runtime_domain.t ->
  action:action ->
  images:image list ->
  resources:resource list ->
  command_id:string ->
  text:string ->
  (t, string) result

val prompt :
  runtime:Runtime_domain.t ->
  images:image list ->
  resources:resource list ->
  command_id:string ->
  text:string ->
  (t, string) result

val command_id : t -> string
val action : t -> action

(* Replace only the runtime fence for a same-identity retry. *)
val retarget : t -> runtime:Runtime_domain.t -> t
val to_yojson : t -> Yojson.Safe.t
