open! Core

let fail message = failwith message

let command ?input_hint name description : Runtime_domain.available_command =
  { name; description; input_hint }

let active text cursor =
  match Command_picker.active_at_cursor ~text ~cursor with
  | Some active -> active
  | None ->
      fail (Printf.sprintf "expected slash command in %S at %d" text cursor)

let () =
  let compact = command "compact" "Compact the active session" in
  let skill = command ~input_hint:"target" "skill:review" "Review code" in
  let command = active "/ski arguments" 4 in
  if (not (String.equal command.query "ski")) || command.stop <> 4 then
    fail "slash command bounds were parsed incorrectly";
  if
    Option.is_some (Command_picker.active_at_cursor ~text:" /compact" ~cursor:9)
  then fail "a slash command not at the first character opened the picker";
  if
    Option.is_some
      (Command_picker.active_at_cursor ~text:"/compact args" ~cursor:13)
  then fail "a slash command remained active after its arguments began";
  let matches =
    Command_picker.matching_commands ~query:"ski" [ compact; skill ]
  in
  (match matches with
  | [ command ] when String.equal command.name "skill:review" -> ()
  | _ -> fail "command picker did not filter available skills");
  (match
     Command_picker.insert_command ~text:"/ski arguments" ~active:command skill
   with
  | Some insertion
    when String.equal insertion.text "/skill:review arguments"
         && insertion.cursor = 13 ->
      ()
  | _ -> fail "skill insertion did not preserve arguments");
  match
    Command_picker.insert_command ~text:"/ski" ~active:(active "/ski" 4) skill
  with
  | Some insertion
    when String.equal insertion.text "/skill:review " && insertion.cursor = 14
    ->
      ()
  | _ -> fail "command input hint did not add an argument separator"
