open Js_of_ocaml

let create () =
  let crypto = Js.Unsafe.get Dom_html.window "crypto" in
  let uuid : Js.js_string Js.t = Js.Unsafe.meth_call crypto "randomUUID" [||] in
  "web-" ^ Js.to_string uuid
