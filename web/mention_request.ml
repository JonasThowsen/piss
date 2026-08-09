open! Core
open Js_of_ocaml

type error = Cancelled | Failed of string

let generation = ref 0
let controller : Js.Unsafe.any option ref = ref None

let present value =
  Js.to_bool
    (Js.Unsafe.coerce
       (Js.Unsafe.fun_call
          (Js.Unsafe.get (Js.Unsafe.inject Dom_html.window) "Boolean")
          [| value |]))

let abort_current () =
  Option.iter !controller ~f:(fun value ->
      try ignore (Js.Unsafe.meth_call value "abort" [||]) with _ -> ());
  controller := None

let cancel () =
  incr generation;
  abort_current ()

let error_message value =
  try
    let message = Js.Unsafe.get value "message" in
    if present message then Js.to_string (Js.Unsafe.coerce message)
    else "File mention request failed"
  with _ -> "File mention request failed"

let search ~session_id ~query ~on_result =
  incr generation;
  let request = !generation in
  abort_current ();
  match
    Request_target.same_origin ~path:"/api/v2/file-mentions"
      ~query:[ ("session", session_id); ("query", query) ]
  with
  | Error message ->
      on_result ~generation:request (Error (Failed message));
      request
  | Ok target ->
      let window = Js.Unsafe.inject Dom_html.window in
      let options = Js.Unsafe.obj [||] in
      let constructor = Js.Unsafe.get window "AbortController" in
      if present constructor then (
        let value = Js.Unsafe.new_obj constructor [||] in
        controller := Some value;
        Js.Unsafe.set options "signal" (Js.Unsafe.get value "signal"));
      let finish result =
        if request = !generation then (
          controller := None;
          on_result ~generation:request result)
      in
      let rejected =
        Js.wrap_callback (fun error ->
            finish (Error (Failed (error_message error))))
      in
      let received =
        Js.wrap_callback (fun response ->
            let ok : bool Js.t = Js.Unsafe.get response "ok" in
            let status : int = Js.Unsafe.get response "status" in
            let text_promise = Js.Unsafe.meth_call response "text" [||] in
            let decoded =
              Js.wrap_callback (fun body ->
                  let body = Js.to_string (Js.Unsafe.coerce body) in
                  if Js.to_bool ok then
                    finish
                      (Result.map_error (Mention_picker.decode_response body)
                         ~f:(fun message -> Failed message))
                  else
                    finish
                      (Error
                         (Failed
                            (if String.is_empty body then
                               Printf.sprintf "HTTP %d" status
                             else body))))
            in
            ignore
              (Js.Unsafe.meth_call text_promise "then"
                 [| Js.Unsafe.inject decoded; Js.Unsafe.inject rejected |]))
      in
      let promise =
        Js.Unsafe.meth_call window "fetch"
          [| Js.Unsafe.inject (Js.string target); Js.Unsafe.inject options |]
      in
      ignore
        (Js.Unsafe.meth_call promise "then"
           [| Js.Unsafe.inject received; Js.Unsafe.inject rejected |]);
      request
