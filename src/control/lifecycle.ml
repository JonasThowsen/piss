(* Session worker process lifecycle: launcher, stopper, and spec files. *)

open Control_prelude

type session_locks = (string, Eio.Mutex.t) Hashtbl.t

let create_session_locks () = Hashtbl.create 32

let with_session_lock locks session_id operation =
  let lock =
    match Hashtbl.find_opt locks session_id with
    | Some lock -> lock
    | None ->
        let lock = Eio.Mutex.create () in
        Hashtbl.add locks session_id lock;
        lock
  in
  Eio.Mutex.use_ro lock operation

let valid_session_id value =
  let valid_character = function
    | 'a' .. 'z' | '0' .. '9' | '-' -> true
    | _ -> false
  in
  String.length value >= 3
  && String.length value <= 64
  && String.for_all valid_character value

let valid_title value =
  let value = String.trim value in
  String.length value >= 1
  && String.length value <= 120
  && not (String.contains value '\000')

let random_session_id () =
  let channel = open_in_bin "/dev/urandom" in
  let bytes =
    Fun.protect
      ~finally:(fun () -> close_in_noerr channel)
      (fun () -> really_input_string channel 16)
  in
  let buffer = Buffer.create 34 in
  Buffer.add_string buffer "s-";
  String.iter
    (fun byte ->
      Buffer.add_string buffer (Printf.sprintf "%02x" (Char.code byte)))
    bytes;
  Buffer.contents buffer

let rec mkdir_p path =
  if path <> "" && path <> Filename.dirname path && not (Sys.file_exists path)
  then (
    mkdir_p (Filename.dirname path);
    Unix.mkdir path 0o700)

let write_private_file path contents =
  let temporary = path ^ ".tmp" in
  let channel = open_out_bin temporary in
  Fun.protect
    ~finally:(fun () -> close_out_noerr channel)
    (fun () -> output_string channel contents);
  Unix.chmod temporary 0o600;
  Unix.rename temporary path

let session_socket runtime_root session_id =
  Filename.concat (Filename.concat runtime_root session_id) "worker.sock"

let rec remove_tree path =
  match Unix.lstat path with
  | { Unix.st_kind = Unix.S_DIR; _ } ->
      Sys.readdir path
      |> Array.iter (fun name -> remove_tree (Filename.concat path name));
      Unix.rmdir path
  | _ -> Unix.unlink path
  | exception Unix.Unix_error (Unix.ENOENT, _, _) -> ()

let write_session_spec registry state_root (session : Registry.session) =
  let directory = Filename.concat state_root session.id in
  let workspace =
    match Registry.find_workspace registry session.workspace_id with
    | Some workspace -> workspace
    | None -> raise (Invalid_argument "session workspace is not registered")
  in
  mkdir_p directory;
  write_private_file
    (Filename.concat directory "harness")
    (session.harness ^ "\n");
  write_private_file
    (Filename.concat directory "broker-token")
    (session.broker_token ^ "\n");
  write_private_file
    (Filename.concat directory "workspace")
    (workspace.root ^ "\n")

let write_session_model_spec state_root (session : Registry.session) model =
  let directory = Filename.concat state_root session.id in
  mkdir_p directory;
  write_private_file (Filename.concat directory "model") (model ^ "\n")

let run ?(timeout_seconds = 60.) ~process_mgr ~clock executable session_id =
  if not (valid_session_id session_id) then Error "invalid session identity"
  else
    try
      let status =
        Eio.Time.with_timeout_exn clock timeout_seconds (fun () ->
            Eio.Switch.run (fun sw ->
                Eio.Process.spawn ~sw process_mgr ~executable
                  [ executable; session_id ]
                |> Eio.Process.await))
      in
      match status with
      | `Exited 0 -> Ok ()
      | `Exited code ->
          Error
            (Printf.sprintf
               "session lifecycle command %s for %s exited with status %d"
               executable session_id code)
      | `Signaled signal ->
          Error
            (Printf.sprintf
               "session lifecycle command %s for %s received signal %d"
               executable session_id signal)
    with
    | Eio.Time.Timeout ->
        Error
          (Printf.sprintf
             "session lifecycle command %s for %s timed out after %.3g seconds"
             executable session_id timeout_seconds)
    | exn ->
        Error
          (Printf.sprintf "session lifecycle command %s for %s failed: %s"
             executable session_id (Printexc.to_string exn))
