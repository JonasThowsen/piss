val to_yojson :
  Runtime_domain.t ->
  mutation_id:string ->
  request_id:string ->
  option_id:string option ->
  Yojson.Safe.t
