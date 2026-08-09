let to_yojson ~request_id ~option_id =
  `Assoc
    [
      ("requestId", `String request_id);
      ( "optionId",
        Option.fold option_id ~none:`Null ~some:(fun value -> `String value) );
    ]
