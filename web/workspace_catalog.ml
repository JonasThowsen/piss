open! Core

type workspace = {
  id : string;
  name : string;
  root : string;
  created_at : float;
}

type group = { workspace : workspace; sessions : Control_plane.Session.t list }

let ( let* ) result f = Result.bind result ~f
let error path expected = Error (path ^ " " ^ expected)

let field fields path name =
  match List.Assoc.find fields ~equal:String.equal name with
  | Some value -> Ok value
  | None -> error (path ^ "." ^ name) "is required"

let string path = function
  | `String value when not (String.is_empty value) -> Ok value
  | `String _ -> error path "must not be empty"
  | _ -> error path "must be a string"

let number path = function
  | `Int value -> Ok (Float.of_int value)
  | `Intlit value -> (
      match Float.of_string_opt value with
      | Some value when Float.is_finite value -> Ok value
      | _ -> error path "must be a finite number")
  | `Float value when Float.is_finite value -> Ok value
  | _ -> error path "must be a finite number"

let field_as fields path name decode =
  let* value = field fields path name in
  decode (path ^ "." ^ name) value

let decode_workspace index = function
  | `Assoc fields ->
      let path = Printf.sprintf "workspaces[%d]" index in
      let* id = field_as fields path "id" string in
      let* name = field_as fields path "name" string in
      let* root = field_as fields path "root" string in
      let* created_at = field_as fields path "createdAt" number in
      if not (String.is_prefix root ~prefix:"/") then
        error (path ^ ".root") "must be an absolute path"
      else Ok { id; name; root; created_at }
  | _ -> error (Printf.sprintf "workspaces[%d]" index) "must be an object"

let decode body =
  match Result.try_with (fun () -> Yojson.Safe.from_string body) with
  | Error exn -> Error ("response is not valid JSON: " ^ Exn.to_string exn)
  | Ok (`List values) -> values |> List.mapi ~f:decode_workspace |> Result.all
  | Ok _ -> Error "response must be a JSON array"

let group workspaces sessions =
  List.map workspaces ~f:(fun workspace ->
      {
        workspace;
        sessions =
          List.filter sessions ~f:(fun (session : Control_plane.Session.t) ->
              String.equal session.workspace_id workspace.id);
      })

let reconcile_selection ~previous sessions =
  match previous with
  | Some id
    when List.exists sessions ~f:(fun (session : Control_plane.Session.t) ->
             String.equal session.id id) ->
      Some id
  | _ -> Option.map (List.hd sessions) ~f:(fun session -> session.id)

let find_workspace workspaces id =
  List.find workspaces ~f:(fun workspace -> String.equal workspace.id id)
