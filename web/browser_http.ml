open! Core
open! Async_kernel

let target path query =
  Request_target.same_origin ~path ~query |> Result.map_error ~f:Error.of_string

let get ?(query = []) path =
  match target path query with
  | Error error -> Deferred.return (Error error)
  | Ok target -> Async_js.Http.get target

let post_json ?(query = []) path json =
  match target path query with
  | Error error -> Deferred.return (Error error)
  | Ok url ->
      Async_js.Http.request ~url
        ~headers:
          [
            ("Content-Type", "application/json"); ("Accept", "application/json");
          ]
        ~response_type:Async_js.Http.Response_type.Default
        (Async_js.Http.Method_with_args.Post
           (Some (Async_js.Http.Post_body.String (Yojson.Safe.to_string json))))
      |> Deferred.Or_error.map ~f:(fun response -> response.content)
