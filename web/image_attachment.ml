open! Core

type t = { mime_type : string; data : string; name : string; size : int }

let max_count = 4
let max_total_bytes = 10 * 1024 * 1024

let supported_mime_types =
  [ "image/png"; "image/jpeg"; "image/gif"; "image/webp" ]

let is_base64_character = function
  | 'A' .. 'Z' | 'a' .. 'z' | '0' .. '9' | '+' | '/' -> true
  | _ -> false

let decoded_size data =
  let length = String.length data in
  if length = 0 || length mod 4 <> 0 then Error "Image data is not valid base64"
  else
    let padding =
      if length >= 2 && Char.equal data.[length - 2] '=' then 2
      else if Char.equal data.[length - 1] '=' then 1
      else 0
    in
    let payload_length = length - padding in
    let payload_valid =
      String.for_all (String.prefix data payload_length) ~f:is_base64_character
    in
    let padding_valid =
      String.for_all
        (String.drop_prefix data payload_length)
        ~f:(Char.equal '=')
    in
    if not (payload_valid && padding_valid) then
      Error "Image data is not valid base64"
    else Ok ((length / 4 * 3) - padding)

let of_base64 ~name ~mime_type data =
  if not (List.mem supported_mime_types mime_type ~equal:String.equal) then
    Error
      ("Unsupported image type: "
      ^ if String.is_empty mime_type then name else mime_type)
  else if
    String.is_empty name || String.length name > 255 || String.mem name '\000'
  then Error "Image name is invalid"
  else
    Result.map (decoded_size data) ~f:(fun size ->
        { mime_type; data; name; size })

let of_data_url ~name ~mime_type value =
  let prefix = "data:" ^ mime_type ^ ";base64," in
  if not (String.is_prefix value ~prefix) then
    Error "FileReader returned an invalid image data URL"
  else
    let data = String.drop_prefix value (String.length prefix) in
    of_base64 ~name ~mime_type data

let validate_total images =
  if List.length images > max_count then
    Error "At most four images may be attached"
  else if
    List.sum (module Int) images ~f:(fun image -> image.size) > max_total_bytes
  then Error "Image attachments exceed the 10 MiB limit"
  else Ok ()

let mime_type image = image.mime_type
let data image = image.data
let name image = image.name
let size image = image.size
let data_url image = "data:" ^ image.mime_type ^ ";base64," ^ image.data
