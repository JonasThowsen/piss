(* Anchored glob matching for configured browser origins. Only '*' is
   special. *)

let matches pattern origin =
  let pattern_length = String.length pattern in
  let origin_length = String.length origin in
  let rec skip_trailing_stars pattern_index =
    if pattern_index < pattern_length && pattern.[pattern_index] = '*' then
      skip_trailing_stars (pattern_index + 1)
    else pattern_index
  in
  let rec loop pattern_index origin_index star retry_origin =
    if pattern_index < pattern_length && pattern.[pattern_index] = '*' then
      loop (pattern_index + 1) origin_index (Some pattern_index) origin_index
    else if
      pattern_index < pattern_length
      && origin_index < origin_length
      && Char.equal pattern.[pattern_index] origin.[origin_index]
    then loop (pattern_index + 1) (origin_index + 1) star retry_origin
    else if origin_index = origin_length then
      skip_trailing_stars pattern_index = pattern_length
    else
      match star with
      | Some star_index when retry_origin < origin_length ->
          let retry_origin = retry_origin + 1 in
          loop (star_index + 1) retry_origin star retry_origin
      | Some _ | None -> false
  in
  loop 0 0 None 0
