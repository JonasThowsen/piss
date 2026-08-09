open! Core

type resource = { path : string }
type image = { mime_type : string; data : string; name : string }
type action = Prompt | Steer | Follow_up

type t = {
  command_id : string;
  text : string;
  images : image list;
  resources : resource list;
  action : action;
}

let action_to_string = function
  | Prompt -> "prompt"
  | Steer -> "steer"
  | Follow_up -> "follow_up"

let action_of_string = function
  | "prompt" -> Ok Prompt
  | "steer" -> Ok Steer
  | "follow_up" -> Ok Follow_up
  | value -> Error ("unsupported command action: " ^ value)

let create ~action ~images ~resources ~command_id ~text =
  if String.is_empty command_id then Error "commandId must not be empty"
  else if String.length command_id > 128 then Error "commandId is too long"
  else if String.length text > 65536 then
    Error "Prompt is limited to 65536 characters"
  else if
    String.is_empty (String.strip text)
    && List.is_empty images && List.is_empty resources
  then Error "Message must contain text, an image, or a resource"
  else if
    List.exists resources ~f:(fun resource -> String.is_empty resource.path)
  then Error "resource path must not be empty"
  else
    let attachments =
      List.map images ~f:(fun image ->
          Image_attachment.of_data_url ~name:image.name
            ~mime_type:image.mime_type
            ("data:" ^ image.mime_type ^ ";base64," ^ image.data))
      |> Result.all
    in
    Result.bind attachments ~f:(fun attachments ->
        Result.map (Image_attachment.validate_total attachments) ~f:(fun () ->
            { command_id; text; images; resources; action }))

let prompt ~images ~resources ~command_id ~text =
  create ~action:Prompt ~images ~resources ~command_id ~text

let command_id command = command.command_id
let action command = command.action

let to_yojson command =
  `Assoc
    [
      ("commandId", `String command.command_id);
      ("text", `String command.text);
      ( "images",
        `List
          (List.map command.images ~f:(fun image ->
               `Assoc
                 [
                   ("mimeType", `String image.mime_type);
                   ("data", `String image.data);
                   ("name", `String image.name);
                 ])) );
      ( "resources",
        `List
          (List.map command.resources ~f:(fun resource ->
               `Assoc [ ("path", `String resource.path) ])) );
      ("action", `String (action_to_string command.action));
    ]
