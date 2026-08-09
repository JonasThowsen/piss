open! Core
open! Async_kernel
open Js_of_ocaml

let target path query =
  Request_target.same_origin ~path ~query |> Result.map_error ~f:Error.of_string

let get ?(query = []) path =
  match target path query with
  | Error error -> Deferred.return (Error error)
  | Ok target -> Async_js.Http.get target

let present value =
  Js.to_bool
    (Js.Unsafe.coerce
       (Js.Unsafe.fun_call
          (Js.Unsafe.get (Js.Unsafe.inject Dom_html.window) "Boolean")
          [| value |]))

let error_body ~status body =
  if String.is_empty body then Printf.sprintf "HTTP %d" status
  else
    match Result.try_with (fun () -> Yojson.Safe.from_string body) with
    | Ok (`Assoc fields) -> (
        match List.Assoc.find fields ~equal:String.equal "error" with
        | Some (`String message) when not (String.is_empty message) -> message
        | _ -> body)
    | _ -> body

let post_json ?(query = []) path json =
  match target path query with
  | Error error -> Deferred.return (Error error)
  | Ok url -> (
      let result = Ivar.create () in
      let finish value = Ivar.fill_if_empty result value in
      let rejected =
        Js.wrap_callback (fun error ->
            let message =
              try
                let value = Js.Unsafe.get error "message" in
                if present value then Js.to_string (Js.Unsafe.coerce value)
                else "HTTP request failed"
              with _ -> "HTTP request failed"
            in
            finish (Error (Error.of_string message)))
      in
      try
        let headers =
          Js.Unsafe.obj
            [|
              ("Content-Type", Js.Unsafe.inject (Js.string "application/json"));
              ("Accept", Js.Unsafe.inject (Js.string "application/json"));
            |]
        in
        let options =
          Js.Unsafe.obj
            [|
              ("method", Js.Unsafe.inject (Js.string "POST"));
              ("headers", Js.Unsafe.inject headers);
              ("body", Js.Unsafe.inject (Js.string (Yojson.Safe.to_string json)));
            |]
        in
        let received =
          Js.wrap_callback (fun response ->
              let response = Js.Unsafe.inject response in
              let ok : bool Js.t = Js.Unsafe.get response "ok" in
              let status : int = Js.Unsafe.get response "status" in
              let body_promise = Js.Unsafe.meth_call response "text" [||] in
              let decoded =
                Js.wrap_callback (fun body ->
                    let body = Js.to_string (Js.Unsafe.coerce body) in
                    if Js.to_bool ok then finish (Ok body)
                    else
                      finish (Error (Error.of_string (error_body ~status body))))
              in
              ignore
                (Js.Unsafe.meth_call body_promise "then"
                   [| Js.Unsafe.inject decoded; Js.Unsafe.inject rejected |]))
        in
        let promise =
          Js.Unsafe.meth_call
            (Js.Unsafe.inject Dom_html.window)
            "fetch"
            [| Js.Unsafe.inject (Js.string url); Js.Unsafe.inject options |]
        in
        ignore
          (Js.Unsafe.meth_call promise "then"
             [| Js.Unsafe.inject received; Js.Unsafe.inject rejected |]);
        Ivar.read result
      with exn -> Deferred.return (Error (Error.of_exn exn)))
