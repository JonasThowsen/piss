open! Core

let fail message = raise_s [%message message]
let expect_error = function Ok _ -> fail "expected an error" | Error _ -> ()

let runtime status =
  {
    Runtime_domain.session_id = "session";
    worker_id = "worker";
    worker_generation = "generation";
    runtime_generation = 1;
    worker_pid = 1;
    harness_pid = Some 2;
    agent_name = "mock";
    status;
    first_sequence = 0L;
    last_sequence = 0L;
    retention_pruned = false;
    upgrade_pending = false;
    accepts_images = true;
    config_options = [];
  }

let () =
  if
    not
      (phys_equal
         (Composer_policy.derive ~has_session:true
            ~runtime:(Some (runtime Requires_action))
            ~connecting:false ~submitting:false ~image_processing:false)
         Requires_action)
  then fail "requires_action composer state was not explicit";
  let image =
    match
      Image_attachment.of_data_url ~name:"proof.gif" ~mime_type:"image/gif"
        "data:image/gif;base64,R0lGODlhAQABAAAAACw="
    with
    | Ok image -> image
    | Error message -> fail message
  in
  if Image_attachment.size image <> 14 then fail "decoded image size was wrong";
  let first_token = Image_batch.next_token Image_batch.empty in
  let first_batch = Image_batch.apply Image_batch.empty (Begin first_token) in
  if not (Image_batch.processing first_batch) then
    fail "image batch did not enter processing";
  let cleared = Image_batch.apply first_batch Clear in
  let stale_success =
    Image_batch.apply cleared (Complete (first_token, Ok [ image ]))
  in
  let stale_error =
    Image_batch.apply stale_success
      (Complete (first_token, Error "stale error"))
  in
  if
    Image_batch.processing stale_error
    || (not (List.is_empty (Image_batch.images stale_error)))
    || Option.is_some (Image_batch.notification stale_error)
  then fail "clear did not invalidate stale image completions";
  let second_token = Image_batch.next_token stale_error in
  let second_batch = Image_batch.apply stale_error (Begin second_token) in
  let old_completion =
    Image_batch.apply second_batch (Complete (first_token, Ok [ image ]))
  in
  if
    (not (Image_batch.processing old_completion))
    || not (List.is_empty (Image_batch.images old_completion))
  then fail "stale completion changed a newer image batch";
  let completed =
    Image_batch.apply old_completion (Complete (second_token, Ok [ image ]))
  in
  if
    Image_batch.processing completed
    || List.length (Image_batch.images completed) <> 1
  then fail "current image completion was not accepted";
  (match Image_batch.notification completed with
  | Some (_, "") -> ()
  | _ -> fail "current image completion did not publish success");
  expect_error
    (Image_attachment.of_data_url ~name:"unsafe.svg" ~mime_type:"image/svg+xml"
       "data:image/svg+xml;base64,PHN2Zz4=");
  expect_error
    (Image_attachment.validate_total (List.init 5 ~f:(fun _ -> image)));
  let oversized_base64 =
    String.make (((Image_attachment.max_total_bytes / 3) + 1) * 4) 'A'
  in
  let oversized =
    match
      Image_attachment.of_data_url ~name:"large.png" ~mime_type:"image/png"
        ("data:image/png;base64," ^ oversized_base64)
    with
    | Ok image -> image
    | Error message -> fail message
  in
  expect_error (Image_attachment.validate_total [ oversized ]);
  let wire_image : Prompt_command.image =
    {
      mime_type = Image_attachment.mime_type image;
      data = Image_attachment.data image;
      name = Image_attachment.name image;
    }
  in
  let command =
    match
      Prompt_command.create ~action:Follow_up ~images:[ wire_image ]
        ~resources:[ { path = "web/App.re" } ]
        ~command_id:"stable-id" ~text:""
    with
    | Ok command -> command
    | Error message -> fail message
  in
  let json = Prompt_command.to_yojson command in
  if
    (not
       (Yojson.Safe.equal
          (Yojson.Safe.Util.member "action" json)
          (`String "follow_up")))
    || not
         (Yojson.Safe.equal
            (Yojson.Safe.Util.member "images" json)
            (`List
               [
                 `Assoc
                   [
                     ("mimeType", `String "image/gif");
                     ("data", `String "R0lGODlhAQABAAAAACw=");
                     ("name", `String "proof.gif");
                   ];
               ]))
  then fail "typed image command emitted the wrong wire JSON";
  expect_error
    (Prompt_command.create ~action:Prompt ~images:[] ~resources:[]
       ~command_id:"large" ~text:(String.make 65537 'x'));
  if
    not
      (phys_equal
         (Composer_policy.action Requires_action ~delivery:Steer)
         Prompt)
  then fail "requires_action inferred a delivery action";
  if
    not
      (phys_equal
         (Composer_policy.action Running ~delivery:Follow_up)
         Follow_up)
  then fail "running follow-up action was lost";
  let outbox =
    Outbox_projection.project
      [
        Accepted { command_id = "prompt"; text = "normal"; action = Prompt };
        Accepted { command_id = "steer"; text = "next"; action = Steer };
        Accepted { command_id = "follow"; text = "later"; action = Follow_up };
        State { command_id = "steer"; state = Completed };
        State { command_id = "follow"; state = Ambiguous };
      ]
  in
  match outbox with
  | [ { command_id = "follow"; status = Ambiguous; _ } ] -> ()
  | _ -> fail "non-prompt outbox projection did not reconcile exactly"
