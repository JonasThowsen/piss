type t = Agent | Details

val all : t list
val label : t -> string
val id : t -> string
val navigate : current:t -> key:string -> t option
