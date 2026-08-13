open! Core

let message ~status body =
  let fallback =
    if String.is_empty body then Printf.sprintf "HTTP %d" status else body
  in
  match Result.try_with (fun () -> Yojson.Safe.from_string body) with
  | Ok (`Assoc fields) -> (
      match List.Assoc.find fields ~equal:String.equal "error" with
      | Some (`String message) when not (String.is_empty message) -> message
      | _ -> fallback)
  | _ -> fallback
