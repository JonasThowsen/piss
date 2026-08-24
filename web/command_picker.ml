open! Core

type active = { query : string; stop : int }
type insertion = { text : string; cursor : int }

let max_query_length = 128

let active_at_cursor ~text ~cursor =
  let length = String.length text in
  if cursor < 1 || cursor > length || not (Char.equal text.[0] '/') then None
  else
    let query = String.sub text ~pos:1 ~len:(cursor - 1) in
    if
      String.length query > max_query_length
      || String.exists query ~f:Char.is_whitespace
    then None
    else Some { query; stop = cursor }

let compare_command query left right =
  let query = String.lowercase query in
  let score command =
    let name = String.lowercase command.Runtime_domain.name in
    if String.is_prefix name ~prefix:query then 0
    else if String.is_substring name ~substring:query then 1
    else 2
  in
  match Int.compare (score left) (score right) with
  | 0 -> String.compare left.name right.name
  | value -> value

let matching_commands ~query commands =
  commands
  |> List.filter ~f:(fun command ->
      let name = String.lowercase command.Runtime_domain.name in
      let query = String.lowercase query in
      String.is_substring name ~substring:query)
  |> List.sort ~compare:(compare_command query)

let insert_command ~text ~active (command : Runtime_domain.available_command) =
  let length = String.length text in
  if active.stop < 1 || active.stop > length || not (Char.equal text.[0] '/')
  then None
  else
    let command_text = "/" ^ command.name in
    let suffix = String.drop_prefix text active.stop in
    let separator =
      if String.is_empty suffix && Option.is_some command.input_hint then " "
      else ""
    in
    Some
      {
        text = command_text ^ separator ^ suffix;
        cursor = String.length command_text + String.length separator;
      }
