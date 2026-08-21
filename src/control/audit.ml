let max_files = 100
let max_patch_bytes = 256 * 1024
let max_reviewable_file_bytes = 1024 * 1024
let max_total_patch_bytes = 2 * 1024 * 1024
let max_status_bytes = 4 * 1024 * 1024
let max_stderr_bytes = 16 * 1024
let timeout_seconds = 10.
let collection_slots = Eio.Semaphore.make 2

type status_entry = {
  path : string;
  previous_path : string option;
  index_status : char;
  worktree_status : char;
}

type file = {
  path : string;
  previous_path : string option;
  index_status : char;
  worktree_status : char;
  patch : string;
  truncated : bool;
  binary : bool;
  role : string;
  reason : string;
  journey_index : int option;
}

type snapshot = {
  generated_at : int64;
  files : file list;
  total_files : int;
  truncated : bool;
}

type error =
  | Validation_error of string
  | Upstream_error of string
  | Internal_error

let error_message = function
  | Validation_error message | Upstream_error message -> message
  | Internal_error -> "Audit failed unexpectedly"

let to_control_error = function
  | Validation_error reason ->
      Control_prelude.Error.Validation { field = "workspace"; reason }
  | Upstream_error message ->
      Control_prelude.Error.Upstream_unavailable { message }
  | Internal_error ->
      Control_prelude.Error.Internal { message = "Audit failed unexpectedly" }

type git_result = {
  status : Eio.Process.exit_status;
  stdout : string;
  stderr : string;
  truncated : bool;
}

type metadata_paths = { git_directory : string; common_directory : string }

type repository = {
  root : string;
  workspace_prefix : string;
  metadata : metadata_paths;
}

type checkout = {
  repository_fd : Unix.file_descr;
  workspace_fd : Unix.file_descr;
  git_fd : Unix.file_descr;
  common_git_fd : Unix.file_descr;
  repository_identity : Unix.stats;
  workspace_identity : Unix.stats;
  git_identity : Unix.stats;
  common_git_identity : Unix.stats;
}

type git_view = Repository | Sanitized of Unix.file_descr

let status_code = function
  | ' ' | 'M' | 'T' | 'A' | 'D' | 'R' | 'C' | 'U' | '?' | '!' -> true
  | _ -> false

let safe_path path =
  path <> "" && Filename.is_relative path
  && (not
        (String.split_on_char '/' path
        |> List.exists (fun component -> component = "..")))
  && not (String.contains path '\000')

let parse_porcelain output =
  let records = Array.of_list (String.split_on_char '\000' output) in
  let entries = ref [] in
  let index = ref 0 in
  while !index < Array.length records do
    let record = records.(!index) in
    if String.length record >= 4 then (
      let index_status = record.[0] in
      let worktree_status = record.[1] in
      let path = String.sub record 3 (String.length record - 3) in
      let renamed =
        index_status = 'R' || index_status = 'C' || worktree_status = 'R'
        || worktree_status = 'C'
      in
      let previous_path =
        if renamed && !index + 1 < Array.length records then
          let candidate = records.(!index + 1) in
          if safe_path candidate then Some candidate else None
        else None
      in
      if
        status_code index_status
        && status_code worktree_status
        && record.[2] = ' '
        && safe_path path
        && (not (index_status = '!' && worktree_status = '!'))
        && ((not renamed) || Option.is_some previous_path)
      then
        entries :=
          { path; previous_path; index_status; worktree_status } :: !entries;
      if renamed then incr index);
    incr index
  done;
  List.rev !entries

let lowercase = String.lowercase_ascii

let contains_any value needles =
  List.exists
    (fun needle ->
      let regexp = Str.regexp_string needle in
      try
        ignore (Str.search_forward regexp value 0);
        true
      with Not_found -> false)
    needles

let basename path = Filename.basename path |> lowercase
let extension path = Filename.extension path |> lowercase

let role_and_reason path =
  let value = lowercase path in
  let name = basename path in
  let ext = extension path in
  if
    contains_any value
      [
        ".pi-subagents/";
        "_build/";
        "node_modules/";
        "dist/";
        "generated";
        "package-lock";
        "flake.lock";
      ]
  then
    ( "Generated",
      "Accounted as generated or derived output; inspect its source change \
       first." )
  else if
    contains_any value
      [
        "migration";
        "auth";
        "security";
        "permission";
        "registry";
        "database";
        "protocol";
        "concurrency";
        "lifecycle";
        "deploy";
      ]
  then
    ( "Risk boundary",
      "Elevated because this path appears to affect a security, persistence, \
       or runtime boundary." )
  else if
    List.mem name
      [
        "dune";
        "dune-project";
        "flake.nix";
        "flake.lock";
        "dockerfile";
        "package.json";
        "piss.opam";
      ]
    || List.mem ext [ ".nix"; ".yaml"; ".yml"; ".toml"; ".json" ]
  then
    ( "Configuration",
      "Elevated because configuration changes can alter how the feature builds \
       or runs." )
  else if
    contains_any value [ "test"; "spec"; "__tests__" ]
    || List.mem ext [ ".mjs"; ".spec" ]
  then
    ( "Proof",
      "Selected as executable evidence for the behavior and its important edge \
       cases." )
  else if
    contains_any value [ "web/"; "frontend/"; "ui/"; "view" ]
    || List.mem ext [ ".css"; ".html"; ".tsx"; ".jsx" ]
  then
    ( "Interface",
      "Selected to show the user-facing boundary and how the feature is \
       presented." )
  else if contains_any value [ "docs/"; "readme" ] || ext = ".md" then
    ( "Documentation",
      "Accounted as explanatory material rather than a primary implementation \
       stop." )
  else
    ( "Implementation",
      "Selected to expose the feature's primary implementation and design \
       choices." )

let score path =
  match fst (role_and_reason path) with
  | "Risk boundary" -> 100
  | "Configuration" -> 90
  | "Interface" -> 70
  | "Proof" -> 60
  | "Implementation" -> 50
  | "Documentation" -> 20
  | _ -> 10

let compare_entries (left : status_entry) (right : status_entry) =
  let by_score = Int.compare (score right.path) (score left.path) in
  if by_score <> 0 then by_score else String.compare left.path right.path

let companion_key path =
  let extension = Filename.extension path |> lowercase in
  if extension = ".ml" || extension = ".mli" then
    String.sub path 0 (String.length path - String.length extension)
  else path

let role_order =
  [
    "Interface";
    "Implementation";
    "Risk boundary";
    "Configuration";
    "Documentation";
    "Generated";
    "Proof";
  ]

let journey_role_rank path =
  let role = fst (role_and_reason path) in
  let rec find index = function
    | [] -> List.length role_order
    | candidate :: _ when candidate = role -> index
    | _ :: rest -> find (index + 1) rest
  in
  find 0 role_order

let select_journey (entries : status_entry list) =
  let ranked = List.sort compare_entries entries in
  let target = min 5 (List.length ranked) in
  let selected : status_entry list ref = ref [] in
  let selected_path path =
    List.exists (fun (entry : status_entry) -> entry.path = path) !selected
  in
  let selected_companion path =
    List.exists
      (fun (entry : status_entry) ->
        companion_key entry.path = companion_key path)
      !selected
  in
  let choose role =
    let candidates =
      List.filter
        (fun (entry : status_entry) ->
          (not (selected_path entry.path))
          && fst (role_and_reason entry.path) = role)
        ranked
    in
    match
      List.find_opt
        (fun (entry : status_entry) -> not (selected_companion entry.path))
        candidates
    with
    | Some entry -> selected := entry :: !selected
    | None -> (
        match candidates with
        | entry :: _ -> selected := entry :: !selected
        | [] -> ())
  in
  (* TODO(tracer): Replace this transparent heuristic with an immutable,
     independently reviewed workflow manifest before Audit can attest deployment
     sign-off; live deterministic selection is sufficient to prove the first
     end-to-end reading journey. *)
  List.iter
    (fun role -> if List.length !selected < target then choose role)
    [ "Interface"; "Implementation"; "Risk boundary"; "Configuration"; "Proof" ];
  let rec fill () =
    if List.length !selected < target then
      let remaining =
        List.filter
          (fun (entry : status_entry) -> not (selected_path entry.path))
          ranked
      in
      let candidate =
        match
          List.find_opt
            (fun (entry : status_entry) -> not (selected_companion entry.path))
            remaining
        with
        | Some entry -> Some entry
        | None -> (
            match remaining with [] -> None | entry :: _ -> Some entry)
      in
      match candidate with
      | None -> ()
      | Some entry ->
          selected := entry :: !selected;
          fill ()
  in
  fill ();
  List.rev !selected
  |> List.sort (fun (left : status_entry) (right : status_entry) ->
      let by_flow =
        Int.compare (journey_role_rank left.path) (journey_role_rank right.path)
      in
      if by_flow <> 0 then by_flow else compare_entries left right)
  |> List.map (fun (entry : status_entry) -> entry.path)

let valid_utf8_sequence value index =
  let length = String.length value in
  let byte offset = Char.code value.[index + offset] in
  let continuation value = value >= 0x80 && value <= 0xbf in
  let lead = byte 0 in
  if lead <= 0x7f then Some 1
  else if lead >= 0xc2 && lead <= 0xdf && index + 1 < length then
    if continuation (byte 1) then Some 2 else None
  else if lead >= 0xe0 && lead <= 0xef && index + 2 < length then
    let second = byte 1 in
    let valid_second =
      if lead = 0xe0 then second >= 0xa0 && second <= 0xbf
      else if lead = 0xed then second >= 0x80 && second <= 0x9f
      else continuation second
    in
    if valid_second && continuation (byte 2) then Some 3 else None
  else if lead >= 0xf0 && lead <= 0xf4 && index + 3 < length then
    let second = byte 1 in
    let valid_second =
      if lead = 0xf0 then second >= 0x90 && second <= 0xbf
      else if lead = 0xf4 then second >= 0x80 && second <= 0x8f
      else continuation second
    in
    if valid_second && continuation (byte 2) && continuation (byte 3) then
      Some 4
    else None
  else None

let sanitize_utf8 value =
  let output = Buffer.create (String.length value) in
  let rec loop index =
    if index < String.length value then
      match valid_utf8_sequence value index with
      | Some width ->
          Buffer.add_substring output value index width;
          loop (index + width)
      | None ->
          Buffer.add_string output "\xef\xbf\xbd";
          loop (index + 1)
  in
  loop 0;
  Buffer.contents output

let utf8_prefix value maximum =
  let rec loop index =
    if index >= String.length value then index
    else
      let width = Option.value (valid_utf8_sequence value index) ~default:1 in
      if index + width > maximum then index else loop (index + width)
  in
  String.sub value 0 (loop 0)

let read_bounded source maximum =
  let retained = Buffer.create (min maximum 16384) in
  let buffer = Cstruct.create 8192 in
  let seen = ref 0 in
  (try
     while true do
       let count = Eio.Flow.single_read source buffer in
       let available = max 0 (maximum - Buffer.length retained) in
       let keep = min available count in
       if keep > 0 then
         Buffer.add_string retained
           (Cstruct.to_string (Cstruct.sub buffer 0 keep));
       seen := !seen + count
     done
   with End_of_file -> ());
  (Buffer.contents retained, !seen > maximum)

let sandbox_environment view =
  let common =
    [
      "HOME=/tmp";
      "LC_ALL=C";
      "GIT_CONFIG_NOSYSTEM=1";
      "GIT_CONFIG_GLOBAL=/dev/null";
      "GIT_ATTR_NOSYSTEM=1";
      "GIT_NO_REPLACE_OBJECTS=1";
      "GIT_NO_LAZY_FETCH=1";
      "GIT_LITERAL_PATHSPECS=1";
      "GIT_OPTIONAL_LOCKS=0";
      "GIT_TERMINAL_PROMPT=0";
      "GIT_PAGER=cat";
      "GIT_WORK_TREE=/proc/self/fd/3";
      "PATH=" ^ Option.value (Sys.getenv_opt "PATH") ~default:"/usr/bin:/bin";
    ]
  in
  match view with
  | Repository ->
      common @ [ "GIT_DIR=/proc/self/fd/4"; "GIT_COMMON_DIR=/proc/self/fd/5" ]
  | Sanitized _ ->
      common
      @ [
          "GIT_DIR=/proc/self/fd/6";
          "GIT_INDEX_FILE=/proc/self/fd/4/index";
          "GIT_OBJECT_DIRECTORY=/proc/self/fd/5/objects";
        ]

let fd_of resource =
  match Eio_unix.Resource.fd_opt resource with
  | Some fd -> fd
  | None -> failwith "Audit process pipe is not backed by a Unix descriptor"

let run_git ~process_mgr ~(checkout : checkout) ~view ~maximum_stdout args =
  Eio.Switch.run @@ fun sw ->
  let stdout, stdout_sink = Eio.Process.pipe ~sw process_mgr in
  let stderr, stderr_sink = Eio.Process.pipe ~sw process_mgr in
  let null_unix =
    Unix.openfile "/dev/null" [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0
  in
  let null_fd = Eio_unix.Fd.of_unix ~sw ~close_unix:true null_unix in
  let repository_fd =
    Eio_unix.Fd.of_unix ~sw ~close_unix:false checkout.repository_fd
  in
  let git_fd = Eio_unix.Fd.of_unix ~sw ~close_unix:false checkout.git_fd in
  let common_git_fd =
    Eio_unix.Fd.of_unix ~sw ~close_unix:false checkout.common_git_fd
  in
  let sanitized_fd =
    match view with
    | Repository -> None
    | Sanitized descriptor ->
        Some (Eio_unix.Fd.of_unix ~sw ~close_unix:false descriptor)
  in
  let fixed =
    [
      "git";
      "-c";
      "safe.directory=/proc/self/fd/3";
      "-c";
      "core.fsmonitor=false";
      "-c";
      "core.hooksPath=/dev/null";
      "-c";
      "core.pager=cat";
      "--no-pager";
      "-C";
      "/proc/self/fd/3";
    ]
    @ args
  in
  let sandbox =
    [
      "landrun";
      "--rox";
      "/nix/store";
      "--ro";
      "/proc/self/fd/3";
      "--ro";
      "/proc/self/fd/4";
      "--ro";
      "/proc/self/fd/5";
    ]
    @ (match view with
      | Repository -> []
      | Sanitized _ -> [ "--ro"; "/proc/self/fd/6" ])
    @ [ "--rw"; "/dev/null" ]
    @ (sandbox_environment view
      |> List.concat_map (fun assignment -> [ "--env"; assignment ]))
    @ fixed
  in
  let process =
    Eio_unix.Process.spawn_unix ~sw process_mgr
      ~env:
        [|
          "PATH="
          ^ Option.value (Sys.getenv_opt "PATH") ~default:"/usr/bin:/bin";
          "LANDRUN_LOG_LEVEL=error";
        |]
      ~fds:
        ([
           (0, null_fd, `Blocking);
           (1, fd_of stdout_sink, `Blocking);
           (2, fd_of stderr_sink, `Blocking);
           (3, repository_fd, `Preserve_blocking);
           (4, git_fd, `Preserve_blocking);
           (5, common_git_fd, `Preserve_blocking);
         ]
        @
        match sanitized_fd with
        | None -> []
        | Some descriptor -> [ (6, descriptor, `Preserve_blocking) ])
      sandbox
  in
  Eio.Flow.close stdout_sink;
  Eio.Flow.close stderr_sink;
  let stdout_result = ref ("", false) in
  let stderr_result = ref ("", false) in
  let status = ref (`Exited 127 : Eio.Process.exit_status) in
  Eio.Fiber.all
    [
      (fun () -> stdout_result := read_bounded stdout maximum_stdout);
      (fun () -> stderr_result := read_bounded stderr max_stderr_bytes);
      (fun () -> status := Eio.Process.await process);
    ];
  let stdout, truncated = !stdout_result in
  let stderr, _ = !stderr_result in
  { status = !status; stdout; stderr; truncated }

let exited result expected =
  match result.status with
  | `Exited code -> List.mem code expected
  | `Signaled _ -> false

let command_error label result =
  let detail = String.trim (sanitize_utf8 result.stderr) in
  if detail = "" then label else label ^ ": " ^ detail

let truncate_utf8 value maximum already_truncated =
  let value = sanitize_utf8 value in
  if String.length value <= maximum && not already_truncated then (value, false)
  else
    let suffix = "\n\n[patch truncated by Piss]\n" in
    let keep = max 0 (maximum - String.length suffix) in
    (utf8_prefix value keep ^ suffix, true)

let binary_patch patch =
  contains_any patch [ "Binary files "; "GIT binary patch" ]

let too_large root (entry : status_entry) =
  let path = Filename.concat root entry.path in
  try
    let stat = Unix.lstat path in
    stat.st_kind = Unix.S_REG && stat.st_size > max_reviewable_file_bytes
  with Unix.Unix_error _ -> false

let collect_file ~process_mgr ~checkout ~view ~root ~workspace_prefix
    (entry : status_entry) =
  let role, reason = role_and_reason entry.path in
  if too_large root entry then
    Ok
      {
        path = entry.path;
        previous_path = entry.previous_path;
        index_status = entry.index_status;
        worktree_status = entry.worktree_status;
        patch = "[file omitted because it exceeds the 1 MiB Audit limit]\n";
        truncated = true;
        binary = false;
        role;
        reason;
        journey_index = None;
      }
  else
    let repository_path path =
      if workspace_prefix = "" then path else workspace_prefix ^ "/" ^ path
    in
    let pathspecs =
      match entry.previous_path with
      | None -> [ repository_path entry.path ]
      | Some previous ->
          [ repository_path previous; repository_path entry.path ]
    in
    let relative_option =
      if workspace_prefix = "" then [] else [ "--relative=" ^ workspace_prefix ]
    in
    let run expected label args =
      let result =
        run_git ~process_mgr ~checkout ~view ~maximum_stdout:max_patch_bytes
          args
      in
      if exited result expected then Ok result
      else Error (Upstream_error (command_error label result))
    in
    let result =
      if entry.index_status = '?' && entry.worktree_status = '?' then
        Result.map
          (fun patch -> (patch.stdout, patch.truncated))
          (run [ 0; 1 ] "Could not read an untracked patch"
             ((if workspace_prefix = "" then [] else [ "-C"; workspace_prefix ])
             @ [
                 "diff";
                 "--no-index";
                 "--no-ext-diff";
                 "--no-textconv";
                 "--no-color";
                 "--unified=3";
                 "--ignore-submodules=all";
                 "--";
                 "/dev/null";
                 entry.path;
               ]))
      else
        let staged =
          if entry.index_status <> ' ' && entry.index_status <> '?' then
            Result.map
              (fun patch -> ("# STAGED\n\n" ^ patch.stdout, patch.truncated))
              (run [ 0 ] "Could not read a staged patch"
                 ([ "diff"; "--cached" ] @ relative_option
                 @ [
                     "--no-ext-diff";
                     "--no-textconv";
                     "--no-color";
                     "--unified=3";
                     "--ignore-submodules=all";
                     "--";
                   ]
                 @ pathspecs))
          else Ok ("", false)
        in
        Result.bind staged (fun (staged, staged_truncated) ->
            if entry.worktree_status <> ' ' && entry.worktree_status <> '?' then
              Result.map
                (fun patch ->
                  ( staged ^ "# UNSTAGED\n\n" ^ patch.stdout,
                    staged_truncated || patch.truncated ))
                (run [ 0 ] "Could not read an unstaged patch"
                   ([ "diff" ] @ relative_option
                   @ [
                       "--no-ext-diff";
                       "--no-textconv";
                       "--no-color";
                       "--unified=3";
                       "--ignore-submodules=all";
                       "--";
                     ]
                   @ pathspecs))
            else Ok (staged, staged_truncated))
    in
    Result.map
      (fun (patch, command_truncated) ->
        let patch, truncated =
          truncate_utf8 patch max_patch_bytes command_truncated
        in
        {
          path = entry.path;
          previous_path = entry.previous_path;
          index_status = entry.index_status;
          worktree_status = entry.worktree_status;
          patch;
          truncated;
          binary = binary_patch patch;
          role;
          reason;
          journey_index = None;
        })
      result

let same_identity left right =
  left.Unix.st_dev = right.Unix.st_dev && left.Unix.st_ino = right.Unix.st_ino

let read_pointer_file path maximum =
  let expected = Unix.lstat path in
  if
    expected.st_kind <> Unix.S_REG
    || expected.st_size < 1 || expected.st_size > maximum
  then Error "Git pointer is not a bounded regular file"
  else
    let descriptor =
      Unix.openfile path [ Unix.O_RDONLY; Unix.O_CLOEXEC; Unix.O_NONBLOCK ] 0
    in
    Fun.protect
      ~finally:(fun () -> Unix.close descriptor)
      (fun () ->
        let actual = Unix.fstat descriptor in
        if not (same_identity expected actual) then
          Error "Git pointer identity changed while it was opened"
        else
          let contents = Bytes.create actual.st_size in
          let rec read offset =
            if offset < actual.st_size then
              let count =
                Unix.read descriptor contents offset (actual.st_size - offset)
              in
              if count = 0 then raise End_of_file else read (offset + count)
          in
          read 0;
          let value = String.trim (Bytes.unsafe_to_string contents) in
          if
            value = ""
            || String.contains value '\000'
            || String.contains value '\r'
          then Error "Git pointer has an invalid format"
          else Ok value)

let validate_metadata_directory directory critical =
  let metadata = Unix.lstat directory in
  if metadata.st_kind <> Unix.S_DIR then
    Error "Git metadata directory is not a real directory"
  else
    match
      List.find_opt
        (fun name ->
          try (Unix.lstat (Filename.concat directory name)).st_kind = Unix.S_LNK
          with Unix.Unix_error (Unix.ENOENT, _, _) -> false)
        critical
    with
    | Some _ -> Error "Symlinked Git metadata cannot be audited safely"
    | None -> Ok ()

let resolve_pointer ~base value =
  let requested =
    if Filename.is_relative value then Filename.concat base value else value
  in
  Unix.realpath requested

let validate_common_metadata common =
  Result.bind
    (validate_metadata_directory common
       [ "HEAD"; "config"; "objects"; "refs"; "packed-refs"; "worktrees" ])
    (fun () ->
      let alternates = Filename.concat common "objects/info/alternates" in
      try
        ignore (Unix.lstat alternates);
        Error "Git object alternates cannot be audited safely"
      with Unix.Unix_error (Unix.ENOENT, _, _) -> Ok ())

let ( let* ) value operation = Result.bind value operation

let validate_git_metadata root =
  let git = Filename.concat root ".git" in
  let metadata =
    try Some (Unix.lstat git) with Unix.Unix_error (Unix.ENOENT, _, _) -> None
  in
  match metadata with
  | None -> Error "No Git repository metadata was found"
  | Some { Unix.st_kind = Unix.S_DIR; _ } ->
      let* () =
        validate_metadata_directory git
          [ "HEAD"; "config"; "index"; "objects"; "refs"; "packed-refs" ]
      in
      let* () = validate_common_metadata git in
      Ok { git_directory = git; common_directory = git }
  | Some { Unix.st_kind = Unix.S_REG; _ } ->
      let* pointer = read_pointer_file git (4 * 1024) in
      let prefix = "gitdir: " in
      if
        String.length pointer <= String.length prefix
        || String.sub pointer 0 (String.length prefix) <> prefix
      then Error "Worktree Git pointer has an invalid format"
      else
        let git_directory =
          resolve_pointer ~base:root
            (String.sub pointer (String.length prefix)
               (String.length pointer - String.length prefix))
        in
        let* () =
          validate_metadata_directory git_directory
            [ "HEAD"; "index"; "commondir"; "gitdir" ]
        in
        let* common_pointer =
          read_pointer_file
            (Filename.concat git_directory "commondir")
            (4 * 1024)
        in
        let common_directory =
          resolve_pointer ~base:git_directory common_pointer
        in
        if Filename.basename common_directory <> ".git" then
          Error "Worktree common Git directory is invalid"
        else if
          Filename.dirname git_directory
          <> Filename.concat common_directory "worktrees"
        then Error "Worktree is not registered by its common repository"
        else
          let* back_pointer =
            read_pointer_file
              (Filename.concat git_directory "gitdir")
              (16 * 1024)
          in
          let registered = resolve_pointer ~base:git_directory back_pointer in
          if registered <> Unix.realpath git then
            Error
              "Worktree Git registration does not point back to this workspace"
          else
            let* () = validate_common_metadata common_directory in
            Ok { git_directory; common_directory }
  | Some _ -> Error "Workspace .git metadata cannot be audited safely"

let open_verified_directory path =
  let expected = Unix.lstat path in
  if expected.st_kind <> Unix.S_DIR then
    invalid_arg "Audit descriptor target is not a directory";
  let descriptor =
    Unix.openfile path [ Unix.O_RDONLY; Unix.O_CLOEXEC; Unix.O_NONBLOCK ] 0
  in
  let actual = Unix.fstat descriptor in
  if same_identity expected actual && actual.st_kind = Unix.S_DIR then
    descriptor
  else (
    Unix.close descriptor;
    failwith "Audit descriptor identity changed while it was opened")

let with_checkout ~workspace_root (repository : repository) operation =
  let repository_fd = open_verified_directory repository.root in
  Fun.protect
    ~finally:(fun () -> Unix.close repository_fd)
    (fun () ->
      let workspace_fd = open_verified_directory workspace_root in
      Fun.protect
        ~finally:(fun () -> Unix.close workspace_fd)
        (fun () ->
          let git_fd =
            open_verified_directory repository.metadata.git_directory
          in
          Fun.protect
            ~finally:(fun () -> Unix.close git_fd)
            (fun () ->
              let common_git_fd =
                open_verified_directory repository.metadata.common_directory
              in
              Fun.protect
                ~finally:(fun () -> Unix.close common_git_fd)
                (fun () ->
                  operation
                    {
                      repository_fd;
                      workspace_fd;
                      git_fd;
                      common_git_fd;
                      repository_identity = Unix.fstat repository_fd;
                      workspace_identity = Unix.fstat workspace_fd;
                      git_identity = Unix.fstat git_fd;
                      common_git_identity = Unix.fstat common_git_fd;
                    }))))

let canonical_approved_roots approved_roots =
  approved_roots
  |> List.filter_map (fun root ->
      try
        let canonical = Unix.realpath root in
        if (Unix.stat canonical).st_kind = Unix.S_DIR then Some canonical
        else None
      with Unix.Unix_error _ -> None)

let path_within ~root path =
  String.equal root path
  ||
  let prefix = if String.ends_with ~suffix:"/" root then root else root ^ "/" in
  String.starts_with ~prefix path

let relative_from ~root path =
  if String.equal root path then Some ""
  else
    let prefix =
      if String.ends_with ~suffix:"/" root then root else root ^ "/"
    in
    if String.starts_with ~prefix path then
      Some
        (String.sub path (String.length prefix)
           (String.length path - String.length prefix))
    else None

let locate_repository ~workspace_root ~approved_roots =
  let approved_roots = canonical_approved_roots approved_roots in
  if
    not
      (List.exists
         (fun approved -> path_within ~root:approved workspace_root)
         approved_roots)
  then Error "This workspace is outside the approved repository roots"
  else
    let candidate_allowed candidate =
      List.exists
        (fun approved -> path_within ~root:approved candidate)
        approved_roots
    in
    let rec walk depth candidate =
      if depth > 8 || not (candidate_allowed candidate) then
        Error "No approved Git repository contains this workspace"
      else
        match validate_git_metadata candidate with
        | Ok metadata -> (
            match relative_from ~root:candidate workspace_root with
            | Some workspace_prefix ->
                Ok { root = candidate; workspace_prefix; metadata }
            | None -> Error "Workspace is not contained by its Git repository")
        | Error "No Git repository metadata was found" ->
            let parent = Filename.dirname candidate in
            if String.equal parent candidate then
              Error "No approved Git repository contains this workspace"
            else walk (depth + 1) parent
        | Error _ as error -> error
    in
    walk 0 workspace_root

let strip_workspace_prefix prefix path =
  if prefix = "" then if safe_path path then Some path else None
  else
    let expected = prefix ^ "/" in
    if String.starts_with ~prefix:expected path then
      let relative =
        String.sub path (String.length expected)
          (String.length path - String.length expected)
      in
      if safe_path relative then Some relative else None
    else None

let scope_entry prefix (entry : status_entry) =
  match strip_workspace_prefix prefix entry.path with
  | None -> None
  | Some path ->
      let previous_path =
        match entry.previous_path with
        | None -> Some None
        | Some previous -> (
            match strip_workspace_prefix prefix previous with
            | None -> None
            | Some value -> Some (Some value))
      in
      Option.map
        (fun previous_path -> { entry with path; previous_path })
        previous_path

let write_all descriptor value =
  let rec write offset =
    if offset < String.length value then
      let count =
        Unix.write_substring descriptor value offset
          (String.length value - offset)
      in
      if count = 0 then failwith "Could not write sanitized Git metadata"
      else write (offset + count)
  in
  write 0

let write_private path value =
  let descriptor =
    Unix.openfile path
      [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_EXCL; Unix.O_CLOEXEC ]
      0o600
  in
  Fun.protect
    ~finally:(fun () -> Unix.close descriptor)
    (fun () -> write_all descriptor value)

let rec make_private_directory attempts =
  if attempts = 0 then failwith "Could not allocate sanitized Git metadata"
  else
    let path =
      Filename.concat
        (Filename.get_temp_dir_name ())
        ("piss-audit-view-" ^ Lifecycle.random_session_id ())
    in
    try
      Unix.mkdir path 0o700;
      path
    with Unix.Unix_error (Unix.EEXIST, _, _) ->
      make_private_directory (attempts - 1)

let cleanup_private_directory path =
  List.iter
    (fun name ->
      try Unix.unlink (Filename.concat path name)
      with Unix.Unix_error (Unix.ENOENT, _, _) -> ())
    [ "HEAD"; "config" ];
  List.iter
    (fun name ->
      try Unix.rmdir (Filename.concat path name)
      with Unix.Unix_error (Unix.ENOENT, _, _) -> ())
    [ "objects"; "refs" ];
  try Unix.rmdir path with Unix.Unix_error (Unix.ENOENT, _, _) -> ()

let valid_object_id ~format value =
  let expected_length = if format = "sha1" then 40 else 64 in
  String.length value = expected_length
  && String.for_all
       (function '0' .. '9' | 'a' .. 'f' -> true | _ -> false)
       value

(* Repository-scoped commands stop here: config inspection and rev-parse do not
   inspect worktree content or evaluate attributes. Every command that computes
   status or patches receives the private [Sanitized] view below, so a config
   race can add filter/diff-driver names but cannot supply executable
   commands. *)
let repository_identity ~process_mgr ~checkout =
  let run label args =
    let result =
      run_git ~process_mgr ~checkout ~view:Repository ~maximum_stdout:256 args
    in
    if exited result [ 0 ] && not result.truncated then
      Ok (String.trim (sanitize_utf8 result.stdout))
    else Error (Upstream_error (command_error label result))
  in
  let* format =
    run "Could not resolve the repository object format"
      [ "rev-parse"; "--show-object-format" ]
  in
  if format <> "sha1" && format <> "sha256" then
    Error (Validation_error "Repository uses an unsupported Git object format")
  else
    let* head =
      run "Audit requires a valid HEAD commit"
        [ "rev-parse"; "--verify"; "--end-of-options"; "HEAD^{commit}" ]
    in
    if valid_object_id ~format head then Ok (format, head)
    else
      Error
        (Validation_error
           "Repository HEAD did not resolve to a valid object identity")

let with_sanitized_view ~format ~head operation =
  let directory = make_private_directory 8 in
  Fun.protect
    ~finally:(fun () -> cleanup_private_directory directory)
    (fun () ->
      Unix.mkdir (Filename.concat directory "objects") 0o700;
      Unix.mkdir (Filename.concat directory "refs") 0o700;
      write_private (Filename.concat directory "HEAD") (head ^ "\n");
      write_private
        (Filename.concat directory "config")
        ("[core]\n\trepositoryFormatVersion = 1\n\tbare = false\n"
       ^ "[extensions]\n\tobjectFormat = " ^ format ^ "\n");
      let descriptor = open_verified_directory directory in
      Fun.protect
        ~finally:(fun () -> Unix.close descriptor)
        (fun () -> operation (Sanitized descriptor)))

let collect_unbounded ~process_mgr ~root ~approved_roots ~before_sanitized =
  let configured = Unix.lstat root in
  if configured.st_kind <> Unix.S_DIR then
    Error (Validation_error "Workspace is not a directory")
  else
    let canonical = Unix.realpath root in
    let canonical_stat = Unix.stat canonical in
    if not (same_identity configured canonical_stat) then
      Error
        (Validation_error
           "Workspace identity changed while resolving its canonical path")
    else
      Result.bind
        (locate_repository ~workspace_root:canonical ~approved_roots
        |> Result.map_error (fun message -> Validation_error message))
        (fun repository ->
          let repository_stat = Unix.stat repository.root in
          with_checkout ~workspace_root:canonical repository (fun checkout ->
              let filters =
                run_git ~process_mgr ~checkout ~view:Repository
                  ~maximum_stdout:(64 * 1024)
                  [
                    "config";
                    "--no-includes";
                    "--null";
                    "--get-regexp";
                    "^(include|includeIf)\\.|^filter\\..*\\.(clean|process)$";
                  ]
              in
              if not (exited filters [ 0; 1 ]) then
                Error
                  (Upstream_error
                     (command_error "Could not validate Git configuration"
                        filters))
              else if filters.truncated || filters.stdout <> "" then
                Error
                  (Validation_error
                     "Repositories with executable Git filters or config \
                      includes cannot be audited safely")
              else
                match repository_identity ~process_mgr ~checkout with
                | Error _ as error -> error
                | Ok (format, head) ->
                    with_sanitized_view ~format ~head (fun view ->
                        before_sanitized ();
                        let status =
                          run_git ~process_mgr ~checkout ~view
                            ~maximum_stdout:max_status_bytes
                            [
                              "status";
                              "--porcelain=v1";
                              "-z";
                              "--untracked-files=all";
                              "--ignore-submodules=all";
                              "--";
                              (if repository.workspace_prefix = "" then "."
                               else repository.workspace_prefix);
                            ]
                        in
                        if not (exited status [ 0 ]) then
                          Error
                            (Upstream_error
                               (command_error
                                  "This workspace is not an accessible Git \
                                   repository"
                                  status))
                        else if status.truncated then
                          Error
                            (Validation_error
                               "This repository has too many changed paths to \
                                audit safely")
                        else
                          let entries =
                            parse_porcelain status.stdout
                            |> List.filter_map
                                 (scope_entry repository.workspace_prefix)
                          in
                          let rec take count values =
                            match (count, values) with
                            | 0, _ | _, [] -> []
                            | count, value :: rest ->
                                value :: take (count - 1) rest
                          in
                          let selected =
                            entries |> List.sort compare_entries
                            |> take max_files
                          in
                          let rec collect_files accumulated = function
                            | [] -> Ok (List.rev accumulated)
                            | entry :: rest -> (
                                match
                                  collect_file ~process_mgr ~checkout ~view
                                    ~root:canonical
                                    ~workspace_prefix:
                                      repository.workspace_prefix entry
                                with
                                | Error _ as error -> error
                                | Ok file ->
                                    collect_files (file :: accumulated) rest)
                          in
                          Result.map
                            (fun files ->
                              let journey = select_journey selected in
                              let journey_index path =
                                let rec find index = function
                                  | [] -> None
                                  | candidate :: _ when candidate = path ->
                                      Some index
                                  | _ :: rest -> find (index + 1) rest
                                in
                                find 1 journey
                              in
                              let total_bytes = ref 0 in
                              let response_truncated =
                                ref (List.length entries > max_files)
                              in
                              let files =
                                List.map
                                  (fun file ->
                                    let bytes = String.length file.patch in
                                    if
                                      !total_bytes + bytes
                                      > max_total_patch_bytes
                                    then (
                                      response_truncated := true;
                                      {
                                        file with
                                        patch =
                                          "[patch omitted because the Audit \
                                           response reached its 2 MiB limit]\n";
                                        truncated = true;
                                        journey_index = journey_index file.path;
                                      })
                                    else (
                                      total_bytes := !total_bytes + bytes;
                                      if file.truncated then
                                        response_truncated := true;
                                      {
                                        file with
                                        journey_index = journey_index file.path;
                                      }))
                                  files
                              in
                              let check_identity label expected fd path =
                                if
                                  not
                                    (same_identity expected (Unix.fstat fd)
                                    && same_identity expected (Unix.stat path))
                                then
                                  failwith
                                    (label
                                   ^ " identity changed while the Audit was \
                                      being collected")
                              in
                              check_identity "Workspace"
                                checkout.workspace_identity
                                checkout.workspace_fd canonical;
                              check_identity "Repository"
                                checkout.repository_identity
                                checkout.repository_fd repository.root;
                              check_identity "Git metadata"
                                checkout.git_identity checkout.git_fd
                                repository.metadata.git_directory;
                              check_identity "Common Git metadata"
                                checkout.common_git_identity
                                checkout.common_git_fd
                                repository.metadata.common_directory;
                              if
                                not
                                  (same_identity canonical_stat
                                     checkout.workspace_identity
                                  && same_identity repository_stat
                                       checkout.repository_identity)
                              then
                                failwith
                                  "Audit checkout identities changed before \
                                   collection";
                              (match validate_git_metadata repository.root with
                              | Ok final_metadata
                                when final_metadata.git_directory
                                     = repository.metadata.git_directory
                                     && final_metadata.common_directory
                                        = repository.metadata.common_directory
                                ->
                                  ()
                              | Ok _ ->
                                  failwith
                                    "Git metadata location changed while the \
                                     Audit was being collected"
                              | Error _ ->
                                  failwith
                                    "Git metadata validation failed after \
                                     collection");
                              {
                                generated_at =
                                  Int64.of_float (Unix.gettimeofday () *. 1000.);
                                files;
                                total_files = List.length entries;
                                truncated = !response_truncated;
                              })
                            (collect_files [] selected))))

let collect_with_hook ~process_mgr ~clock ~root ~approved_roots
    ~before_sanitized =
  try
    Eio.Time.with_timeout_exn clock timeout_seconds (fun () ->
        Eio.Semaphore.acquire collection_slots;
        Fun.protect
          ~finally:(fun () -> Eio.Semaphore.release collection_slots)
          (fun () ->
            collect_unbounded ~process_mgr ~root ~approved_roots
              ~before_sanitized))
  with
  | Eio.Time.Timeout ->
      Error (Upstream_error "Git Audit timed out after 10 seconds")
  | Unix.Unix_error
      ((Unix.EACCES | Unix.EPERM | Unix.ENOENT | Unix.ENOTDIR), _, _) ->
      Error (Validation_error "Workspace could not be read safely")
  | Unix.Unix_error _ ->
      Error (Upstream_error "Workspace could not be read safely")
  | Failure _ | Invalid_argument _ -> Error Internal_error
  | _ -> Error Internal_error

let collect ~process_mgr ~clock ~approved_roots ~root =
  collect_with_hook ~process_mgr ~clock ~root ~approved_roots
    ~before_sanitized:(fun () -> ())

let collect_for_test ~process_mgr ~clock ~approved_roots ~root ~before_sanitized
    =
  collect_with_hook ~process_mgr ~clock ~root ~approved_roots ~before_sanitized

(* The production entry point above never exposes the deterministic race
   seam. *)

let char_json value = `String (String.make 1 value)
let string_json value = `String (sanitize_utf8 value)

let file_to_yojson file =
  `Assoc
    [
      ("path", string_json file.path);
      ( "previousPath",
        match file.previous_path with
        | None -> `Null
        | Some value -> string_json value );
      ("indexStatus", char_json file.index_status);
      ("worktreeStatus", char_json file.worktree_status);
      ("patch", string_json file.patch);
      ("truncated", `Bool file.truncated);
      ("binary", `Bool file.binary);
      ("role", string_json file.role);
      ("reason", string_json file.reason);
      ( "journeyIndex",
        match file.journey_index with None -> `Null | Some value -> `Int value
      );
    ]

let snapshot_to_yojson snapshot =
  let highlighted =
    List.fold_left
      (fun count file ->
        match file.journey_index with None -> count | Some _ -> count + 1)
      0 snapshot.files
  in
  `Assoc
    [
      ("generatedAt", `Intlit (Int64.to_string snapshot.generated_at));
      ("totalFiles", `Int snapshot.total_files);
      ("accountedFiles", `Int (List.length snapshot.files));
      ("highlightedFiles", `Int highlighted);
      ("truncated", `Bool snapshot.truncated);
      ("files", `List (List.map file_to_yojson snapshot.files));
    ]
