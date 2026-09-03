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

let finished_at ~seen_finished_at (session : Control_plane.Session.t) =
  if not (phys_equal session.status Idle) then None
  else
    Option.filter session.last_finished_at ~f:(fun finished_at ->
        Option.value_map (Map.find seen_finished_at session.id) ~default:true
          ~f:(fun seen_at -> Float.(seen_at < finished_at)))

let status_label ~seen_finished_at (session : Control_plane.Session.t) =
  if Option.is_some (finished_at ~seen_finished_at session) then "finished"
  else Control_plane.Session.status_to_string session.status

let searchable ~seen_finished_at session workspace =
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
      status_label ~seen_finished_at session;
      workspace_name;
      workspace_root;
    ]
  |> String.lowercase

let status_rank ~seen_finished_at (session : Control_plane.Session.t) =
  match (session.status, finished_at ~seen_finished_at session) with
  | Idle, Some _ | (Requires_action | Stopped | Failed), _ -> 0
  | (Starting | Waiting | Running), _ -> 1
  | (Idle | Offline), _ -> 2
  | Archived, _ -> 3

let workspace_name = function
  | Some (workspace : Workspace_catalog.workspace) -> workspace.name
  | None -> "Unknown workspace"

let items ~scope ~query ~seen_finished_at ~workspaces ~active ~archived =
  let requested = match scope with Active -> active | Archived -> archived in
  let terms = terms query in
  requested
  |> List.filter_map ~f:(fun (session : Control_plane.Session.t) ->
      let workspace =
        Workspace_catalog.find_workspace workspaces session.workspace_id
      in
      let value = searchable ~seen_finished_at session workspace in
      if
        List.for_all terms ~f:(fun term ->
            String.is_substring value ~substring:term)
      then Some { session; workspace }
      else None)
  |> List.sort ~compare:(fun left right ->
      let by_status =
        Int.compare
          (status_rank ~seen_finished_at left.session)
          (status_rank ~seen_finished_at right.session)
      in
      if by_status <> 0 then by_status
      else
        let by_finished =
          match
            ( finished_at ~seen_finished_at left.session,
              finished_at ~seen_finished_at right.session )
          with
          | Some left, Some right -> Float.compare right left
          | Some _, None -> -1
          | None, Some _ -> 1
          | None, None -> 0
        in
        if by_finished <> 0 then by_finished
        else
          let by_workspace =
            String.Caseless.compare
              (workspace_name left.workspace)
              (workspace_name right.workspace)
          in
          if by_workspace <> 0 then by_workspace
          else
            let by_workspace_id =
              String.compare left.session.workspace_id
                right.session.workspace_id
            in
            if by_workspace_id <> 0 then by_workspace_id
            else
              let by_title =
                String.Caseless.compare left.session.title right.session.title
              in
              if by_title <> 0 then by_title
              else String.compare left.session.id right.session.id)

let move ~count ~current ~delta =
  if count <= 0 then 0 else (current + delta + count) mod count

(* Moves a session-search selection without wrapping past either result
   boundary. *)
let move_clamped ~count ~current ~delta =
  if count <= 0 then 0 else Int.min (count - 1) (Int.max 0 (current + delta))
