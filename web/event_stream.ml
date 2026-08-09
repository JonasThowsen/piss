open! Core
open Js_of_ocaml

type selection = { generation : int; session_id : string }

type active = {
  generation : int;
  source : EventSource.eventSource Js.t;
  mutable closed : bool;
}

let generation = ref 0
let active = ref None

let close_active () =
  Option.iter !active ~f:(fun stream ->
      stream.closed <- true;
      ignore (Js.Unsafe.meth_call stream.source "close" [||]));
  active := None

let close () =
  Int.incr generation;
  close_active ()

let select ~session_id =
  close ();
  { generation = !generation; session_id }

let connect (selection : selection) ~after ~on_event ~on_open ~on_error =
  if selection.generation <> !generation then Ok ()
  else
    match
      Request_target.same_origin ~path:"/api/v2/event-stream"
        ~query:
          [
            ("session", selection.session_id); ("after", Int64.to_string after);
          ]
    with
    | Error _ as error -> error
    | Ok target ->
        close_active ();
        let source : EventSource.eventSource Js.t =
          Js.Unsafe.new_obj
            (Js.Unsafe.pure_js_expr "EventSource")
            [| Js.Unsafe.inject (Js.string target) |]
          |> Js.Unsafe.coerce
        in
        let stream =
          { generation = selection.generation; source; closed = false }
        in
        let current () =
          (not stream.closed) && stream.generation = !generation
        in
        Js.Unsafe.set source "onmessage"
          (Dom.handler (fun event ->
               (if current () then
                  let data : Js.js_string Js.t = Js.Unsafe.get event "data" in
                  on_event (Js.to_string data));
               Js._true));
        Js.Unsafe.set source "onopen"
          (Dom.handler (fun _ ->
               if current () then on_open ();
               Js._true));
        Js.Unsafe.set source "onerror"
          (Dom.handler (fun _ ->
               if current () then on_error ();
               Js._true));
        active := Some stream;
        Ok ()
