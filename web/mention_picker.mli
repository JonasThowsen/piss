type resource = { path : string; name : string; kind : string; size : int }
type active = { query : string; start : int; stop : int }
type insertion = { text : string; cursor : int }
type availability = Loading | Ready of resource list | Failed of string

type model =
  | Closed
  | Open of {
      active : active;
      generation : int;
      availability : availability;
      selected : int;
    }

val max_query_length : int
val active_at_cursor : text:string -> cursor:int -> active option

val insert_trigger :
  text:string -> selection_start:int -> selection_end:int -> insertion

val insert_resource :
  text:string -> active:active -> path:string -> insertion option

val token : string -> string
val add_resource : resource list -> resource -> resource list
val reconcile : text:string -> resource list -> resource list
val decode_response : string -> (resource list, string) result
val loading : active -> generation:int -> model
val resolve : model -> generation:int -> resource list -> model
val fail : model -> generation:int -> string -> model
val move : model -> int -> model
val select_index : model -> int -> model
val selected_resource : model -> resource option
