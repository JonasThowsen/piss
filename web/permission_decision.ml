let to_yojson runtime ~mutation_id ~request_id ~option_id =
  Runtime_domain.mutation_to_yojson runtime ~mutation_id
    [
      ("requestId", `String request_id);
      ( "optionId",
        Option.fold option_id ~none:`Null ~some:(fun value -> `String value) );
    ]
