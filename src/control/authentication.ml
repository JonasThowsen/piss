(* Tailscale identity and same-origin mutation policy. *)

open Cohttp

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

(* Glob-style pattern match where '*' matches any run of characters. We
   translate the pattern to a regular expression (escape every non-asterisk
   character, then turn '*' into '.*') and run it through Str.regexp. The
   hand-rolled recursive matcher I tried first was buggy in the non-empty
   consume branch and would loop forever or fail to find a valid match. *)
let origin_matches pattern origin =
  let regex_pattern =
    let buf = Buffer.create (String.length pattern + 4) in
    Buffer.add_string buf "^";
    String.iter
      (function
        | '*' -> Buffer.add_string buf ".*"
        | c ->
            Buffer.add_char buf '\\';
            Buffer.add_char buf c)
      pattern;
    Buffer.add_string buf "$";
    Buffer.contents buf
  in
  let re = Str.regexp regex_pattern in
  try
    ignore (Str.search_forward re origin 0);
    true
  with Not_found -> false

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
           NixOS module can pass 'https://piss-ocaml.*.ts.net' and accept every
           Tailscale Serve URL for that hostname without knowing the tailnet up
           front. *)
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
                 (fun pattern -> origin_matches pattern o)
                 accepted_patterns ->
            Ok ()
        | _ -> Error (`Forbidden, "same-origin mutation required"))
