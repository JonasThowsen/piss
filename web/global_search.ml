open! Core

type scope = Active | Archived

type item = {
  session : Control_plane.Session.t;
  workspace : Workspace_catalog.workspace option;
}

let terms query =
  String.lowercase (String.strip query)
  |> String.split ~on:' '
  |> List.filter ~f:(Fn.non String.is_empty)

let searchable session workspace =
  let workspace_name, workspace_root =
    Option.value_map workspace ~default:("", "")
      ~f:(fun (workspace : Workspace_catalog.workspace) ->
        (workspace.Workspace_catalog.name, workspace.root))
  in
  String.concat ~sep:" "
    [
      session.Control_plane.Session.title;
      session.id;
      Control_plane.Session.harness_to_string session.harness;
      Control_plane.Session.status_to_string session.status;
      workspace_name;
      workspace_root;
    ]
  |> String.lowercase

let items ~scope ~query ~workspaces ~active ~archived =
  let requested = match scope with Active -> active | Archived -> archived in
  let terms = terms query in
  requested
  |> List.filter_map ~f:(fun (session : Control_plane.Session.t) ->
      let workspace =
        Workspace_catalog.find_workspace workspaces session.workspace_id
      in
      let value = searchable session workspace in
      if
        List.for_all terms ~f:(fun term ->
            String.is_substring value ~substring:term)
      then Some { session; workspace }
      else None)
  |> List.sort ~compare:(fun left right ->
      let by_title =
        String.Caseless.compare left.session.title right.session.title
      in
      if by_title <> 0 then by_title
      else String.compare left.session.id right.session.id)

let move ~count ~current ~delta =
  if count <= 0 then 0 else (current + delta + count) mod count
