open! Core

let fail message = raise_s [%message message]

let patch =
  {|
diff --git a/lib/example.ml b/lib/example.ml
index 111..222 100644
--- a/lib/example.ml
+++ b/lib/example.ml
@@ -4,4 +4,5 @@ let answer =
 let stable = true
-let previous = 41
+let previous = 42
+let added = true
 let tail = true
@@ -20 +21 @@
-old_tail
+new_tail
|}

let () =
  let parsed = Diff_view_domain.parse_unified_patch patch in
  if List.length parsed.hunks <> 2 then fail "diff parser lost a hunk";
  if parsed.rendered_line_count <> 7 then
    fail "diff parser counted source rows incorrectly";
  let first_hunk = List.hd_exn parsed.hunks in
  (match Diff_view_domain.split_rows first_hunk with
  | [ context; replacement; added; _ ] ->
      if
        not
          (Option.equal Int.equal
             (Option.value_exn context.left).Diff_view_domain.old_number
             (Some 4))
      then fail "context old line number was not retained";
      if
        not
          (String.equal
             (Option.value_exn replacement.left).Diff_view_domain.text
             "let previous = 41")
      then fail "deletion was not paired on the left";
      if
        not
          (String.equal
             (Option.value_exn replacement.right).Diff_view_domain.text
             "let previous = 42")
      then fail "addition was not paired on the right";
      if Option.is_some added.left || Option.is_none added.right then
        fail "unpaired addition did not retain an empty old cell"
  | _ -> fail "split diff rows were not paired in review order");
  let additions, deletions = Diff_view_domain.change_counts parsed in
  if additions <> 3 || deletions <> 2 then
    fail "change statistics were not derived";
  let old_segments, new_segments =
    Diff_view_domain.word_segments ~original:"let answer = 41"
      ~revised:"let answer = 42"
  in
  if
    (not
       (List.exists old_segments ~f:(function
         | Diff_view_domain.Emphasized "41" -> true
         | Plain _ | Emphasized _ -> false)))
    || not
         (List.exists new_segments ~f:(function
           | Diff_view_domain.Emphasized "42" -> true
           | Plain _ | Emphasized _ -> false))
  then fail "changed word was not emphasized";
  let generated_patch =
    List.init (Diff_view_domain.diff_page_line_count + 1) ~f:(fun index ->
        Printf.sprintf "+generated_%d" index)
    |> String.concat ~sep:"\n"
    |> fun lines -> "@@ -0,0 +1,5000 @@\n" ^ lines
  in
  let first_page = Diff_view_domain.parse_unified_patch generated_patch in
  if
    first_page.rendered_line_count <> Diff_view_domain.diff_page_line_count
    || first_page.total_line_count <> Diff_view_domain.diff_page_line_count + 1
  then fail "diff parser no longer applies its deterministic page bound";
  let second_page =
    Diff_view_domain.parse_unified_patch
      ~first_line:Diff_view_domain.diff_page_line_count generated_patch
  in
  if
    second_page.rendered_line_count <> 1
    || second_page.total_line_count <> first_page.total_line_count
    || second_page.additions <> first_page.additions
  then fail "later diff pages did not retain the complete patch accounting"
