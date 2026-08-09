(* Static asset serving for the browser shell. *)

let safe_asset_path root resource =
  match resource with
  | "/" -> Some (Filename.concat root "index.html", "text/html; charset=utf-8")
  | "/styles.css" ->
      Some (Filename.concat root "styles.css", "text/css; charset=utf-8")
  | resource when String.starts_with ~prefix:"/fonts/" resource ->
      let name = Filename.basename resource in
      if
        name = resource || String.contains name '/' || String.contains name '\\'
      then None
      else
        let content_type =
          if Filename.extension name = ".ttf" then "font/ttf"
          else "text/plain; charset=utf-8"
        in
        Some (Filename.concat (Filename.concat root "fonts") name, content_type)
  | _ -> None

let serve path content_type =
  try
    let channel = open_in_bin path in
    let body =
      Fun.protect
        ~finally:(fun () -> close_in_noerr channel)
        (fun () -> really_input_string channel (in_channel_length channel))
    in
    Cohttp_eio.Server.respond_string ~status:`OK
      ~headers:(Headers.text_headers content_type)
      ~body ()
  with Sys_error _ -> Headers.error_json ~status:`Not_found "asset not found"
