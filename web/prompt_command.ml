open! Core

type resource = { path : string }
type t = { command_id : string; text : string; resources : resource list }

let prompt ~resources ~command_id ~text =
  if String.is_empty command_id then Error "commandId must not be empty"
  else if String.length command_id > 128 then Error "commandId is too long"
  else if String.is_empty (String.strip text) then
    Error "prompt text must not be empty"
  else if
    List.exists resources ~f:(fun resource -> String.is_empty resource.path)
  then Error "resource path must not be empty"
  else Ok { command_id; text; resources }

let command_id command = command.command_id

let to_yojson command =
  `Assoc
    [
      ("commandId", `String command.command_id);
      ("text", `String command.text);
      ("images", `List []);
      ( "resources",
        `List
          (List.map command.resources ~f:(fun resource ->
               `Assoc [ ("path", `String resource.path) ])) );
      ("action", `String "prompt");
    ]
