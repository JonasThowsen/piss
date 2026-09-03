open! Core
open! Bonsai_web.Cont
open Bonsai.Let_syntax
open Js_of_ocaml

type output = {
  images : Image_attachment.t list;
  processing : bool;
  paste_attr : Vdom.Attr.t;
  previews : Vdom.Node.t;
  view : Vdom.Node.t;
  clear : unit -> unit Effect.t;
}

type pending_image_reference = {
  selection : Image_references.selection;
  first_image_number : int;
}

let input_id = "composer-image-input"
let class_ name = Vdom.Attr.class_ name
let text = Vdom.Node.text

let present value =
  Js.to_bool
    (Js.Unsafe.coerce
       (Js.Unsafe.fun_call
          (Js.Unsafe.get (Js.Unsafe.inject Dom_html.window) "Boolean")
          [| value |]))

let property_string value name =
  try Js.to_string (Js.Unsafe.coerce (Js.Unsafe.get value name)) with _ -> ""

let property_int value name = try Js.Unsafe.get value name with _ -> 0

let files_from_list list =
  if not (present list) then []
  else
    let length = property_int list "length" in
    List.filter_map (List.init length ~f:Fn.id) ~f:(fun index ->
        let file =
          Js.Unsafe.meth_call list "item" [| Js.Unsafe.inject index |]
        in
        if present file then Some file else None)

let input_files event =
  let target = Js.Unsafe.get (Js.Unsafe.inject event) "currentTarget" in
  files_from_list (Js.Unsafe.get target "files")

let paste_files event =
  let clipboard = Js.Unsafe.get (Js.Unsafe.inject event) "clipboardData" in
  if not (present clipboard) then []
  else
    files_from_list (Js.Unsafe.get clipboard "files")
    |> List.filter ~f:(fun file ->
        String.is_prefix (property_string file "type") ~prefix:"image/")

let clear_input () =
  let input =
    Js.Unsafe.meth_call
      (Js.Unsafe.inject Dom_html.document)
      "getElementById"
      [| Js.Unsafe.inject (Js.string input_id) |]
  in
  if present input then Js.Unsafe.set input "value" (Js.string "")

let open_input () =
  let input =
    Js.Unsafe.meth_call
      (Js.Unsafe.inject Dom_html.document)
      "getElementById"
      [| Js.Unsafe.inject (Js.string input_id) |]
  in
  if present input then ignore (Js.Unsafe.meth_call input "click" [||])

let read_as_data_url file =
  let result = Async_kernel.Ivar.create () in
  let constructor = Js.Unsafe.get Js.Unsafe.global "FileReader" in
  let reader = Js.Unsafe.new_obj constructor [||] in
  let finish value =
    if not (Async_kernel.Ivar.is_full result) then
      Async_kernel.Ivar.fill_exn result value
  in
  Js.Unsafe.set reader "onload"
    (Js.Unsafe.inject
       (Js.wrap_callback (fun _ ->
            let value = property_string reader "result" in
            finish (Ok value))));
  Js.Unsafe.set reader "onerror"
    (Js.Unsafe.inject
       (Js.wrap_callback (fun _ -> finish (Error "An image could not be read"))));
  ignore (Js.Unsafe.meth_call reader "readAsDataURL" [| file |]);
  Async_kernel.Ivar.read result

let decode_file file =
  let open Async_kernel.Deferred.Let_syntax in
  let name =
    let value = property_string file "name" in
    if String.is_empty value then "Pasted image" else value
  in
  let mime_type = property_string file "type" in
  let%map result = read_as_data_url file in
  Result.bind result ~f:(Image_attachment.of_data_url ~name ~mime_type)

let format_size bytes =
  if bytes >= 1024 * 1024 then
    Printf.sprintf "%.1f MiB" (Float.of_int bytes /. 1048576.)
  else if bytes >= 1024 then
    Printf.sprintf "%.1f KiB" (Float.of_int bytes /. 1024.)
  else Int.to_string bytes ^ " B"

let component ~available ~on_notice ~on_processing ~composer_selection
    ~on_images_added ~on_image_removed graph =
  let pending_image_reference = ref None in
  let state, inject =
    Bonsai.state_machine0 ~default_model:Image_batch.empty
      ~apply_action:(fun _ state action -> Image_batch.apply state action)
      ~sexp_of_model:(fun _ -> Sexp.Atom "image-batch")
      ~sexp_of_action:(fun _ -> Sexp.Atom "image-batch-action")
      graph
  in
  let processing_value =
    let%arr state = state in
    Image_batch.processing state
  in
  Bonsai.Edge.on_change processing_value ~equal:Bool.equal
    ~callback:on_processing graph;
  let notification_value =
    let%arr state = state in
    Image_batch.notification state
  in
  let notify =
    let%arr on_notice = on_notice in
    function None -> Effect.Ignore | Some (_, message) -> on_notice message
  in
  Bonsai.Edge.on_change notification_value
    ~equal:(Option.equal (fun (left, _) (right, _) -> Int.equal left right))
    ~callback:notify graph;
  let%arr available = available
  and on_notice = on_notice
  and state = state
  and inject = inject
  and composer_selection = composer_selection
  and on_images_added = on_images_added
  and on_image_removed = on_image_removed in
  let images = Image_batch.images state in
  let processing = Image_batch.processing state in
  let select ?selection files =
    clear_input ();
    let saved_reference = !pending_image_reference in
    pending_image_reference := None;
    let selection =
      Option.value selection
        ~default:
          (Option.value_map saved_reference ~default:(composer_selection ())
             ~f:(fun pending -> pending.selection))
    in
    let first_image_number =
      Option.value_map saved_reference
        ~default:(List.length images + 1)
        ~f:(fun pending -> pending.first_image_number)
    in
    if (not available) || processing || List.is_empty files then Effect.Ignore
    else if List.length images + List.length files > Image_attachment.max_count
    then on_notice "At most four images may be attached"
    else
      let unsupported =
        List.find files ~f:(fun file ->
            not
              (List.mem Image_attachment.supported_mime_types
                 (property_string file "type")
                 ~equal:String.equal))
      in
      match unsupported with
      | Some file ->
          let kind = property_string file "type" in
          on_notice
            ("Unsupported image type: "
            ^ if String.is_empty kind then property_string file "name" else kind
            )
      | None ->
          let selected_bytes =
            List.sum
              (module Int)
              files
              ~f:(fun file -> property_int file "size")
          in
          let current_bytes =
            List.sum (module Int) images ~f:Image_attachment.size
          in
          if current_bytes + selected_bytes > Image_attachment.max_total_bytes
          then on_notice "Image attachments exceed the 10 MiB limit"
          else
            let token = Image_batch.next_token state in
            pending_image_reference := Some { selection; first_image_number };
            Effect.bind (inject (Image_batch.Begin token)) ~f:(fun () ->
                Effect.bind
                  (Effect.of_deferred_thunk (fun () ->
                       Async_kernel.Deferred.all (List.map files ~f:decode_file)))
                  ~f:(fun decoded ->
                    let result =
                      Result.bind (Result.all decoded) ~f:(fun additions ->
                          Result.map
                            (Image_attachment.validate_total (images @ additions))
                            ~f:(fun () -> additions))
                    in
                    Effect.bind
                      (inject (Image_batch.Complete (token, result)))
                      ~f:(fun () ->
                        match (result, !pending_image_reference) with
                        | Ok additions, Some pending ->
                            pending_image_reference := None;
                            on_images_added ~text:pending.selection.text
                              ~start:pending.selection.start
                              ~stop:pending.selection.stop
                              ~first_image_number:pending.first_image_number
                              ~count:(List.length additions)
                        | Error _, Some _ ->
                            pending_image_reference := None;
                            Effect.Ignore
                        | Ok _, None | Error _, None -> Effect.Ignore)))
  in
  let remove index =
    Effect.bind (inject (Image_batch.Remove index)) ~f:(fun () ->
        on_image_removed ~removed_image_number:(index + 1)
          ~image_count:(List.length images))
  in
  let paste_attr =
    Vdom.Attr.on_paste (fun event ->
        let files = paste_files event in
        if List.is_empty files then Effect.Ignore
        else
          let start, stop = Composer_ui.event_selection event 0 in
          let current_selection = composer_selection () in
          let selection =
            { Image_references.text = current_selection.text; start; stop }
          in
          let restore_focus () = Composer_ui.focus_selection ~start ~stop in
          restore_focus ();
          Effect.Many [ Vdom.Effect.Prevent_default; select ~selection files ])
  in
  let previews =
    if List.is_empty images then Vdom.Node.none
    else
      Vdom.Node.div
        ~attrs:
          [
            class_ "composer-images";
            Vdom.Attr.create "aria-label" "Attached images";
          ]
        (List.mapi images ~f:(fun index image ->
             Vdom.Node.create "figure" ~key:(Int.to_string index)
               [
                 Vdom.Node.img
                   ~attrs:
                     [
                       Vdom.Attr.src (Image_attachment.data_url image);
                       Vdom.Attr.alt "";
                     ]
                   ();
                 Vdom.Node.button
                   ~attrs:
                     [
                       Vdom.Attr.create "type" "button";
                       Vdom.Attr.create "aria-label"
                         ("Remove " ^ Image_attachment.name image);
                       Vdom.Attr.on_click (fun _ -> remove index);
                     ]
                   [ text "x" ];
                 Vdom.Node.create "figcaption"
                   [
                     Vdom.Node.b [ text (Image_attachment.name image) ];
                     Vdom.Node.small
                       [ text (format_size (Image_attachment.size image)) ];
                   ];
               ]))
  in
  let view =
    Vdom.Node.div
      [
        Vdom.Node.input
          ~attrs:
            ([
               Vdom.Attr.id input_id;
               class_ "composer-image-input";
               Vdom.Attr.create "type" "file";
               Vdom.Attr.create "multiple" "";
               Vdom.Attr.create "accept"
                 (String.concat ~sep:"," Image_attachment.supported_mime_types);
               Vdom.Attr.create "aria-label" "Attach images";
               Vdom.Attr.on_change (fun event _ -> select (input_files event));
             ]
            @ if available && not processing then [] else [ Vdom.Attr.disabled ]
            )
          ();
        Vdom.Node.button
          ~attrs:
            ([
               class_ "attachment-trigger";
               Vdom.Attr.create "type" "button";
               Vdom.Attr.create "aria-label" "Attach images";
               Vdom.Attr.on_click (fun _ ->
                   pending_image_reference :=
                     Some
                       {
                         selection = composer_selection ();
                         first_image_number = List.length images + 1;
                       };
                   open_input ();
                   Effect.Ignore);
             ]
            @ if available && not processing then [] else [ Vdom.Attr.disabled ]
            )
          [ text (if processing then "..." else "+") ];
      ]
  in
  {
    images;
    processing;
    paste_attr;
    previews;
    view;
    clear =
      (fun () ->
        pending_image_reference := None;
        clear_input ();
        inject Image_batch.Clear);
  }
