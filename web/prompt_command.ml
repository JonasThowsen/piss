open! Core

type resource = { path : string }
type image = { mime_type : string; data : string; name : string }
type action = Prompt | Steer | Follow_up

module Submission = struct
  type 'a t = Ready | Sending of 'a | Uncertain of 'a

  let ready = Ready
  let start value = Sending value

  let mark_uncertain = function
    | Sending value -> Uncertain value
    | state -> state

  let retry = function Uncertain value -> Sending value | state -> state
  let abandon _ = Ready

  let pending = function
    | Ready -> None
    | Sending value | Uncertain value -> Some value

  let is_sending = function Sending _ -> true | Ready | Uncertain _ -> false
end

type target = {
  session_id : string;
  worker_id : string;
  runtime_generation : int;
}

type t = {
  target : target;
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

let create ~(runtime : Runtime_domain.t) ~action ~images ~resources ~command_id
    ~text =
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
            {
              target =
                {
                  session_id = runtime.session_id;
                  worker_id = runtime.worker_id;
                  runtime_generation = runtime.runtime_generation;
                };
              command_id;
              text;
              images;
              resources;
              action;
            }))

let prompt ~runtime ~images ~resources ~command_id ~text =
  create ~runtime ~action:Prompt ~images ~resources ~command_id ~text

let command_id command = command.command_id
let action command = command.action

let retarget command ~(runtime : Runtime_domain.t) =
  {
    command with
    target =
      {
        session_id = runtime.session_id;
        worker_id = runtime.worker_id;
        runtime_generation = runtime.runtime_generation;
      };
  }

let to_yojson command =
  `Assoc
    [
      ( "target",
        `Assoc
          [
            ("sessionId", `String command.target.session_id);
            ("workerId", `String command.target.worker_id);
            ("runtimeGeneration", `Int command.target.runtime_generation);
          ] );
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
