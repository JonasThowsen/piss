open! Core

let same_origin ~path ~query =
  let uri = Uri.of_string path in
  if
    (not (String.is_prefix path ~prefix:"/"))
    || String.is_prefix path ~prefix:"//"
    || Option.is_some (Uri.scheme uri)
    || Option.is_some (Uri.host uri)
    || Option.is_some (Uri.userinfo uri)
    || Option.is_some (Uri.fragment uri)
  then Error "HTTP path must be an absolute same-origin path"
  else
    let pct_encoder =
      Uri.pct_encoder ~query_value:(`Custom (`Query_value, "", "/?")) ()
    in
    Ok (Uri.add_query_params' uri query |> Uri.to_string ~pct_encoder)

let path_with_id ~prefix ~id ~suffix =
  let unreserved = function
    | 'a' .. 'z' | 'A' .. 'Z' | '0' .. '9' | '-' | '.' | '_' | '~' -> true
    | _ -> false
  in
  let encoded = Buffer.create (String.length id) in
  String.iter id ~f:(fun character ->
      if unreserved character then Buffer.add_char encoded character
      else
        Buffer.add_string encoded
          (Printf.sprintf "%%%02X" (Char.to_int character)));
  prefix ^ Buffer.contents encoded ^ suffix
