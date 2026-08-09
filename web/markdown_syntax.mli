type inline =
  | Text of string
  | Code of string
  | Bold of string
  | Link of string * string

type block =
  | Paragraph of inline list list
  | Unordered_list of inline list list
  | Ordered_list of inline list list
  | Heading of int * inline list
  | Blockquote of inline list list
  | Fenced_code of { language : string; code : string }

val parse : string -> block list
