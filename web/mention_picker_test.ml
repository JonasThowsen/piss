open! Core

let fail message = failwith message

let active text cursor =
  match Mention_picker.active_at_cursor ~text ~cursor with
  | Some active -> active
  | None ->
      fail (Printf.sprintf "expected active mention in %S at %d" text cursor)

let resource path =
  {
    Mention_picker.path;
    name = Filename.basename path;
    kind = "file";
    size = 4;
  }

let () =
  let mention = active "Review @App before" 11 in
  if
    mention.start <> 7 || mention.stop <> 11
    || not (String.equal mention.query "App")
  then fail "current mention bounds were parsed incorrectly";
  let quoted = active "first\nOpen @\"dir/a f" 20 in
  if not (String.equal quoted.query "dir/a f") then
    fail "quoted mention query was lost";
  if Option.is_some (Mention_picker.active_at_cursor ~text:"mail@App" ~cursor:8)
  then fail "mid-word at sign opened the picker";
  if
    Option.is_some
      (Mention_picker.active_at_cursor ~text:"@old\nplain" ~cursor:10)
  then fail "a mention from an earlier line remained active";
  let long_query = "@" ^ String.make 201 'a' in
  if
    Option.is_some
      (Mention_picker.active_at_cursor ~text:long_query ~cursor:202)
  then fail "an overlong mention query was accepted";
  let trigger =
    Mention_picker.insert_trigger ~text:"reviewTHAT now" ~selection_start:6
      ~selection_end:10
  in
  if (not (String.equal trigger.text "review @ now")) || trigger.cursor <> 8
  then fail "toolbar insertion did not preserve prefix and suffix";
  let insertion =
    Mention_picker.insert_resource ~text:"Review @App before" ~active:mention
      ~path:"web/App.re"
  in
  (match insertion with
  | Some insertion
    when String.equal insertion.text "Review @web/App.re before"
         && insertion.cursor = 18 ->
      ()
  | _ -> fail "plain mention insertion did not preserve surrounding text");
  let spaced = active "Read @\"old" 10 in
  (match
     Mention_picker.insert_resource ~text:"Read @\"old next" ~active:spaced
       ~path:"docs/my file.md"
   with
  | Some insertion
    when String.equal insertion.text "Read @\"docs/my file.md\" next" ->
      ()
  | _ -> fail "spaced path was not quoted during insertion");
  let first = resource "web/App.re" and second = resource "README.md" in
  let selected =
    Mention_picker.add_resource [] first |> fun resources ->
    Mention_picker.add_resource resources first |> fun resources ->
    Mention_picker.add_resource resources second
  in
  let kept =
    Mention_picker.reconcile ~text:"Review @web/App.re, not @README.md" selected
  in
  if
    not
      (List.equal String.equal
         (List.map kept ~f:(fun item -> item.path))
         [ "README.md" ])
  then fail "resource reconciliation did not require an exact mention token";
  let decoded =
    Mention_picker.decode_response
      {|[{"path":"web/App.re","name":"App.re","kind":"file","size":42}]|}
  in
  (match decoded with
  | Ok [ item ]
    when String.equal item.path "web/App.re"
         && String.equal item.name "App.re"
         && item.size = 42 ->
      ()
  | _ -> fail "valid mention response was not decoded");
  let picker =
    Mention_picker.loading mention ~generation:7 |> fun picker ->
    Mention_picker.resolve picker ~generation:7
      [ resource "legacy/web/src/App.tsx"; first ]
  in
  (match Mention_picker.selected_resource picker with
  | Some item when String.equal item.path "web/App.re" -> ()
  | _ -> fail "picker did not rank the closest basename first");
  List.iter
    [
      {|{}|};
      {|[{"path":"x","name":"x","kind":"directory","size":1}]|};
      {|[{"path":"x","name":"x","kind":"file","size":"1"}]|};
      {|[{"path":"x","name":"x","kind":"file","size":-1}]|};
    ] ~f:(fun body ->
      if Result.is_ok (Mention_picker.decode_response body) then
        fail ("malformed mention response was accepted: " ^ body))
