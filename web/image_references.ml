open! Core

type selection = { text : string; start : int; stop : int }

let image_reference number = Printf.sprintf "[image %d]" number

let insert_image_references { text; start; stop } ~first_image_number ~count =
  let start = Int.clamp_exn start ~min:0 ~max:(String.length text) in
  let stop = Int.clamp_exn stop ~min:start ~max:(String.length text) in
  let references =
    List.init count ~f:(fun offset ->
        image_reference (first_image_number + offset))
    |> String.concat ~sep:" "
  in
  let text =
    String.prefix text start ^ references ^ String.drop_prefix text stop
  in
  {
    text;
    start = start + String.length references;
    stop = start + String.length references;
  }

let remove_image_reference ~text ~removed_image_number ~image_count =
  let text =
    String.substr_replace_all text
      ~pattern:(image_reference removed_image_number)
      ~with_:""
  in
  List.fold
    (List.range (removed_image_number + 1) (image_count + 1))
    ~init:text
    ~f:(fun text number ->
      String.substr_replace_all text ~pattern:(image_reference number)
        ~with_:(image_reference (number - 1)))
