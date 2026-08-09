type t = Agent | Working | Details

val all : t list
val label : t -> string
val id : t -> string

val select_after_snapshot :
  previous:Runtime_domain.status option -> next:Runtime_domain.status -> t -> t

val navigate : current:t -> key:string -> t option
