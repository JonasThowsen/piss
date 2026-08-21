(* HTTP response helpers and security headers for the control plane. *)

open Control_prelude

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

let status_of_error = function
  | Error.Not_found _ -> `Not_found
  | Error.Forbidden _ -> `Forbidden
  | Error.Conflict _ -> `Conflict
  | Error.Upstream_unavailable _ -> `Service_unavailable
  | Error.Validation _ -> `Bad_request
  | Error.Internal _ -> `Internal_server_error

let error_json ?status error =
  let status = Option.value status ~default:(status_of_error error) in
  respond_json ~status
    (`Assoc
       [
         ("error", `String (Error.to_string error));
         ("errorDetails", Error.to_yojson error);
       ])
