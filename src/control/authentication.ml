(* Tailscale identity and same-origin mutation policy. *)

open Cohttp
open Control_prelude

let request_header request name = Header.get (Request.headers request) name

let authorized ~allowed_users ~dev_bypass request =
  dev_bypass
  ||
  match request_header request "tailscale-user-login" with
  | Some login -> List.exists (String.equal login) allowed_users
  | None -> false

let valid_json_content request =
  match request_header request "content-type" with
  | Some content_type
    when String.starts_with ~prefix:"application/json" content_type ->
      Ok ()
  | _ -> Error (`Unsupported_media_type, "content-type must be application/json")

let valid_json_mutation ~dev_bypass ~allowed_origins request =
  if dev_bypass then Ok ()
  else
    match valid_json_content request with
    | Error _ as error -> error
    | Ok () -> (
        let origin = request_header request "origin" in
        let host = request_header request "host" in
        let forwarded_host = request_header request "x-forwarded-host" in
        (* The browser sends an Origin header on every state-changing request.
           We accept it when the Origin matches either the Host the worker saw
           directly, the Host the proxy in front of us advertised
           (X-Forwarded-Host), or any pattern in --allowed-origin. The pattern
           syntax is glob-style ('*' matches any run of characters), so the
           NixOS module can pass the configured Piss hostname pattern and accept
           its Tailscale Serve URL without knowing the tailnet up front. *)
        let accepted_patterns =
          let direct =
            match (host, forwarded_host) with
            | Some h, _ -> [ "https://" ^ h; "http://" ^ h ]
            | None, Some h -> [ "https://" ^ h; "http://" ^ h ]
            | None, None -> []
          in
          direct @ List.rev allowed_origins
        in
        match origin with
        | Some o
          when List.exists
                 (fun pattern -> Origin_pattern.matches pattern o)
                 accepted_patterns ->
            Ok ()
        | _ -> Error (`Forbidden, "same-origin mutation required"))
