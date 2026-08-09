open! Core

type t = { command_id : string; text : string }

let prompt ~command_id ~text =
  if String.is_empty command_id then Error "commandId must not be empty"
  else if String.length command_id > 128 then Error "commandId is too long"
  else if String.is_empty (String.strip text) then
    Error "prompt text must not be empty"
  else Ok { command_id; text }

let command_id command = command.command_id

let to_yojson command =
  `Assoc
    [
      ("commandId", `String command.command_id);
      ("text", `String command.text);
      ("images", `List []);
      ("resources", `List []);
      ("action", `String "prompt");
    ]
