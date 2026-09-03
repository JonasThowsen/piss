open! Core

let fail message = raise_s [%message message]

let () =
  let open Image_references in
  if not (String.equal (image_reference 1) "[image 1]") then
    fail "image reference label was not stable";
  let inserted =
    insert_image_references
      { text = "Here is the image."; start = 18; stop = 18 }
      ~first_image_number:1 ~count:1
  in
  if not (String.equal inserted.text "Here is the image.[image 1]") then
    fail
      ("image reference text was not inserted at the composer cursor: "
     ^ inserted.text);
  if inserted.start <> 27 || inserted.stop <> 27 then
    fail
      ("image reference cursor was not after the marker: "
      ^ Int.to_string inserted.start
      ^ "/"
      ^ Int.to_string inserted.stop);
  let replaced =
    insert_image_references
      { text = "before selected after"; start = 7; stop = 15 }
      ~first_image_number:2 ~count:2
  in
  if not (String.equal replaced.text "before [image 2] [image 3] after") then
    fail "multiple image references did not replace the selected text";
  if
    not
      (String.equal
         (remove_image_reference ~text:"[image 1] [image 2] [image 3]"
            ~removed_image_number:2 ~image_count:3)
         "[image 1]  [image 2]")
  then fail "removing an image did not keep later image references aligned"
