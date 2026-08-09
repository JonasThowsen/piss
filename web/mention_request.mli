type error = Cancelled | Failed of string

val search :
  session_id:string ->
  query:string ->
  on_result:
    (generation:int -> (Mention_picker.resource list, error) result -> unit) ->
  int

val cancel : unit -> unit
