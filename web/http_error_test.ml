open! Core

let () =
  let body =
    {|{"error":"Readable message","errorDetails":{"kind":"Validation","reason":"internal"}}|}
  in
  let actual = Http_error.message ~status:400 body in
  if not (String.equal actual "Readable message") then
    failwith ("raw API error leaked into the UI: " ^ actual);
  if not (String.equal (Http_error.message ~status:503 "") "HTTP 503") then
    failwith "empty response fallback changed"
