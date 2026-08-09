open Piss_core

let cases =
  [
    ( Error.Not_found { resource = "session"; id = "session-1" },
      "session not found: session-1" );
    ( Error.Forbidden { reason = "same-origin mutation required" },
      "same-origin mutation required" );
    ( Error.Conflict { reason = "the session already has an active prompt" },
      "the session already has an active prompt" );
    ( Error.Upstream_unavailable { message = "worker socket is unavailable" },
      "worker socket is unavailable" );
    ( Error.Validation
        { field = "commandId"; reason = "commandId must not be empty" },
      "commandId must not be empty" );
    ( Error.Internal { message = "unexpected worker response" },
      "unexpected worker response" );
  ]

let check_round_trip (error, expected_message) =
  let encoded = Error.to_yojson error in
  Alcotest.(check string)
    "human message" expected_message (Error.to_string error);
  match Error.of_yojson encoded with
  | Error message -> Alcotest.fail message
  | Ok decoded ->
      Alcotest.(check string)
        "JSON is stable"
        (Yojson.Safe.to_string encoded)
        (Error.to_yojson decoded |> Yojson.Safe.to_string);
      Alcotest.(check string)
        "human message survives JSON" expected_message (Error.to_string decoded)

let test_error_round_trips () = List.iter check_round_trip cases

let test_wire_error_round_trips () =
  List.iter
    (fun (error, expected_message) ->
      let encoded = Wire.response_to_yojson (Error error) in
      Alcotest.(check bool)
        "wire error is structured" true
        (match Yojson.Safe.Util.member "error" encoded with
        | `Assoc _ -> true
        | _ -> false);
      match Wire.response_of_yojson encoded with
      | Ok _ -> Alcotest.fail "wire error decoded as success"
      | Error decoded ->
          Alcotest.(check string)
            "wire JSON is stable"
            (Error.to_yojson error |> Yojson.Safe.to_string)
            (Error.to_yojson decoded |> Yojson.Safe.to_string);
          Alcotest.(check string)
            "wire message is stable" expected_message (Error.to_string decoded))
    cases

let () =
  Alcotest.run "typed errors"
    [
      ( "error",
        [
          Alcotest.test_case "JSON and strings round trip" `Quick
            test_error_round_trips;
          Alcotest.test_case "wire responses round trip" `Quick
            test_wire_error_round_trips;
        ] );
    ]
