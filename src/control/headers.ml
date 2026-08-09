(* HTTP response helpers and security headers for the control plane. *)

let security_headers =
  [
    ("cache-control", "no-store");
    ( "content-security-policy",
      "default-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self' \
       data:; script-src 'self'; style-src 'self' 'unsafe-inline'; \
       frame-ancestors 'none'; base-uri 'none'; form-action 'none'" );
    ("referrer-policy", "no-referrer");
    ("x-content-type-options", "nosniff");
    ("x-frame-options", "DENY");
  ]

let json_headers =
  Cohttp.Header.of_list
    (("content-type", "application/json; charset=utf-8") :: security_headers)

let text_headers content_type =
  Cohttp.Header.of_list (("content-type", content_type) :: security_headers)

let event_stream_headers =
  Cohttp.Header.of_list
    (("content-type", "text/event-stream; charset=utf-8")
    :: ("x-accel-buffering", "no")
    :: security_headers)

let respond_json ?(status = `OK) json =
  Cohttp_eio.Server.respond_string ~status ~headers:json_headers
    ~body:(Yojson.Safe.to_string json)
    ()

let error_json ?(status = `Bad_request) message =
  respond_json ~status (`Assoc [ ("error", `String message) ])
