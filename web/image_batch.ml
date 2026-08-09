open! Core

type token = int

type t = {
  generation : token;
  images : Image_attachment.t list;
  processing : bool;
  notification_sequence : int;
  notification : (int * string) option;
}

type action =
  | Begin of token
  | Complete of token * (Image_attachment.t list, string) result
  | Clear
  | Remove of int

let empty =
  {
    generation = 0;
    images = [];
    processing = false;
    notification_sequence = 0;
    notification = None;
  }

let next_token state = state.generation + 1

let notify state ~images message =
  let sequence = state.notification_sequence + 1 in
  {
    state with
    images;
    processing = false;
    notification_sequence = sequence;
    notification = Some (sequence, message);
  }

let apply state = function
  | Begin token when (not state.processing) && token > state.generation ->
      { state with generation = token; processing = true }
  | Complete (token, result)
    when state.processing && Int.equal token state.generation -> (
      match result with
      | Error message -> notify state ~images:state.images message
      | Ok additions -> (
          let images = state.images @ additions in
          match Image_attachment.validate_total images with
          | Error message -> notify state ~images:state.images message
          | Ok () -> notify state ~images ""))
  | Clear ->
      {
        state with
        generation = state.generation + 1;
        images = [];
        processing = false;
        notification = None;
      }
  | Remove index ->
      {
        state with
        images =
          List.filteri state.images ~f:(fun candidate _ -> candidate <> index);
      }
  | Begin _ | Complete _ -> state

let images state = state.images
let processing state = state.processing
let notification state = state.notification
