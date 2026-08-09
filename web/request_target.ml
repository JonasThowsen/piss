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
