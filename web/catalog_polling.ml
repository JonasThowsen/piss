open! Core
open! Bonsai_web.Cont
open Js_of_ocaml

let running = ref false
let timer : int option ref = ref None
let revision : Int64.t option ref = ref None
let generation = ref 0

let foregrounded () =
  try
    let document = Js.Unsafe.inject Dom_html.document in
    let state : Js.js_string Js.t = Js.Unsafe.get document "visibilityState" in
    let focused =
      Js.Unsafe.meth_call document "hasFocus" [||]
      |> Js.Unsafe.coerce |> Js.to_bool
    in
    String.equal (Js.to_string state) "visible" && focused
  with _ -> true

let decode_revision body =
  match Result.try_with (fun () -> Yojson.Safe.from_string body) with
  | Ok (`Assoc fields) -> (
      match List.Assoc.find fields ~equal:String.equal "revision" with
      | Some (`Int value) -> Some (Int64.of_int value)
      | Some (`Intlit value) -> Int64.of_string_opt value
      | _ -> None)
  | _ -> None

let clear_timer () =
  Option.iter !timer ~f:(fun id ->
      ignore
        (Js.Unsafe.meth_call
           (Js.Unsafe.inject Dom_html.window)
           "clearTimeout"
           [| Js.Unsafe.inject id |]));
  timer := None

let rec schedule apply milliseconds =
  if !running then
    let callback = Js.wrap_callback (fun () -> tick apply) in
    let id : int =
      Js.Unsafe.meth_call
        (Js.Unsafe.inject Dom_html.window)
        "setTimeout"
        [| Js.Unsafe.inject callback; Js.Unsafe.inject milliseconds |]
    in
    timer := Some id

and refresh apply next expected_generation =
  let open Async_kernel.Deferred.Let_syntax in
  let%map workspaces, sessions =
    Async_kernel.Deferred.both
      (Browser_http.get "/api/v2/workspaces")
      (Browser_http.get "/api/v2/sessions")
  in
  if !running && expected_generation = !generation then
    match (workspaces, sessions) with
    | Ok workspace_body, Ok session_body -> (
        match
          ( Workspace_catalog.decode workspace_body,
            Control_plane.decode_sessions session_body )
        with
        | Ok workspaces, Ok sessions ->
            apply ~workspaces ~sessions;
            revision := Some next
        | Error _, _ | _, Error _ -> ())
    | Error _, _ | _, Error _ -> ()

and tick apply =
  timer := None;
  if not !running then ()
  else
    let foregrounded = foregrounded () in
    let next_tick = if foregrounded then 1_000 else 5_000 in
    Async_kernel.don't_wait_for
      (let open Async_kernel.Deferred.Let_syntax in
       let%bind response = Browser_http.get "/api/v2/catalog-revision" in
       (match Result.ok response |> Option.bind ~f:decode_revision with
         | None -> Async_kernel.Deferred.return ()
         | Some next -> (
             match !revision with
             | Some previous when foregrounded && Int64.equal previous next ->
                 Async_kernel.Deferred.return ()
             | None | Some _ -> refresh apply next !generation))
       >>| fun () -> if !running then schedule apply next_tick)

let invalidate () =
  Int.incr generation;
  revision := None

let cleanup_now () =
  running := false;
  clear_timer ();
  invalidate ()

let start ~apply =
  Effect.of_deferred_thunk (fun () ->
      cleanup_now ();
      running := true;
      schedule apply 1_000;
      Async_kernel.Deferred.return ())

let cleanup () =
  Effect.of_deferred_thunk (fun () ->
      cleanup_now ();
      Async_kernel.Deferred.return ())
