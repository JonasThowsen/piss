self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.piss-next;
  nativePackage = self.packages.${pkgs.stdenv.hostPlatform.system}.piss-next-native;
  controlPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.piss-next-control;
  workerPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.piss-next-worker;
  mockAgentPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.piss-next-mock-agent;
  sessionMcpPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.piss-next-session-mcp;
  webPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.piss-next-web;
  defaultAdapterPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-acp;
  defaultOpenCodePackage = self.packages.${pkgs.stdenv.hostPlatform.system}.opencode;
  serviceStateName = "piss-ocaml";
  runtimeDirectory = "%t/${serviceStateName}";
  stateDirectory = "%S/${serviceStateName}";
  sessionRuntimeRoot = "${runtimeDirectory}/sessions";
  sessionStateRoot = "${stateDirectory}/sessions";
  effectiveWorkspaces =
    if cfg.workspaces == { } then
      {
        default = {
          name = "PISS rewrite";
          path = cfg.workspace;
        };
      }
    else
      cfg.workspaces;
  workspaceEntries = lib.mapAttrsToList (id: value: value // { inherit id; }) effectiveWorkspaces;
  workspaceArguments = lib.concatMap (workspace: [
    "--workspace-spec"
    "${workspace.id}|${workspace.name}|${workspace.path}"
  ]) workspaceEntries;
  workspacePaths = map (workspace: workspace.path) workspaceEntries;
  workspaceDiscoveryArguments = lib.concatMap (path: [
    "--workspace-discovery-root"
    path
  ]) cfg.workspaceDiscoveryRoots;
  workerGeneration = builtins.hashString "sha256" (
    lib.concatStringsSep "\n" (
      map toString [
        cfg.workerPackage
        cfg.adapterPackage
        cfg.opencodePackage
        cfg.mockAgentPackage
        cfg.sessionMcpPackage
      ]
      ++ [
        cfg.piCommand
        (if cfg.opencodeAuthFile == null then "" else cfg.opencodeAuthFile)
        (if cfg.sshAgentSocket == null then "" else cfg.sshAgentSocket)
        (toString cfg.port)
        (builtins.toJSON cfg.environmentFiles)
        (builtins.toJSON workspacePaths)
        (builtins.toJSON cfg.workspaceDiscoveryRoots)
      ]
    )
  );

  workerRunner = pkgs.writeShellScript "piss-ocaml-session-worker" ''
    set -euo pipefail
    # The systemd user manager inherits XDG_STATE_HOME et al. from
    # previous worker runs, which causes `state` to be derived from a
    # session-specific path instead of the canonical root. Wipe them
    # so this script always rebuilds them from a known base.
    unset XDG_STATE_HOME XDG_CACHE_HOME XDG_CONFIG_HOME XDG_DATA_HOME
    id="''${1:?session id required}"
    [[ "$id" =~ ^[a-z0-9-]{3,64}$ ]] || { echo "invalid session id" >&2; exit 64; }
    state="''${XDG_STATE_HOME:-$HOME/.local/state}/${serviceStateName}"
    session_state="$state/sessions/$id"
    session_runtime="''${XDG_RUNTIME_DIR:?}/${serviceStateName}/sessions/$id"
    mkdir -p "$session_state" "$session_runtime" \
      "$session_state/cache" "$session_state/config" \
      "$session_state/data" "$session_state/xdg-state"
    export XDG_CACHE_HOME="$session_state/cache"
    export XDG_CONFIG_HOME="$session_state/config"
    export XDG_DATA_HOME="$session_state/data"
    export XDG_STATE_HOME="$session_state/xdg-state"
    harness="$(tr -d '\n' < "$session_state/harness")"
    broker_token="$(tr -d '\n' < "$session_state/broker-token")"
    workspace="$(tr -d '\n' < "$session_state/workspace")"
    if [[ "$id" == "deployed-tracer" && -e "$state/worker.sqlite3" && ! -e "$session_state/worker.sqlite3" ]]; then
      for suffix in "" -wal -shm; do
        [[ ! -e "$state/worker.sqlite3$suffix" ]] || mv "$state/worker.sqlite3$suffix" "$session_state/worker.sqlite3$suffix"
      done
    fi
    case "$harness" in
      pi)
        command=${lib.escapeShellArg "${cfg.adapterPackage}/bin/pi-acp"}
        args=()
        ;;
      opencode)
        opencode_auth_source=${
          lib.escapeShellArg (if cfg.opencodeAuthFile == null then "" else cfg.opencodeAuthFile)
        }
        if [[ -n "$opencode_auth_source" ]]; then
          [[ -f "$opencode_auth_source" ]] || {
            echo "configured OpenCode authentication file is missing" >&2
            exit 78
          }
          opencode_auth_dir="$session_state/data/opencode"
          opencode_auth_target="$opencode_auth_dir/auth.json"
          ${lib.getExe pkgs.jq} -e 'type == "object"' "$opencode_auth_source" >/dev/null || {
            echo "configured OpenCode authentication file must contain a JSON object" >&2
            exit 78
          }
          mkdir -p "$opencode_auth_dir"
          if [[ ! -f "$opencode_auth_target" || "$opencode_auth_source" -nt "$opencode_auth_target" ]]; then
            opencode_auth_tmp="$opencode_auth_dir/.auth.json.$$"
            ${lib.getExe' pkgs.coreutils "install"} -m 0600 "$opencode_auth_source" "$opencode_auth_tmp"
            ${lib.getExe' pkgs.coreutils "mv"} -f "$opencode_auth_tmp" "$opencode_auth_target"
          fi
        fi
        command=${lib.escapeShellArg "${cfg.opencodePackage}/bin/opencode"}
        args=(--harness-arg acp)
        ;;
      mock)
        command=${lib.escapeShellArg "${cfg.mockAgentPackage}/bin/piss-mock-agent"}
        args=()
        ;;
      *) echo "unsupported harness: $harness" >&2; exit 64 ;;
    esac
    exec ${cfg.workerPackage}/bin/piss-session-worker \
      --socket "$session_runtime/worker.sock" \
      --database "$session_state/worker.sqlite3" \
      --session "$id" \
      --worker "worker-$id" \
      --generation ${lib.escapeShellArg workerGeneration} \
      --workspace "$workspace" \
      --harness "$command" \
      --session-mcp ${cfg.sessionMcpPackage}/bin/piss-session-mcp \
      --broker-url http://127.0.0.1:${toString cfg.port} \
      --broker-token "$broker_token" \
      --curl-command ${lib.getExe pkgs.curl} \
      "''${args[@]}"
  '';

  startWorker = pkgs.writeShellScript "piss-ocaml-start-session" ''
    set -euo pipefail
    id="''${1:?session id required}"
    [[ "$id" =~ ^[a-z0-9-]{3,64}$ ]] || exit 64
    unit="piss-ocaml-worker@$id.service"
    socket="''${XDG_RUNTIME_DIR:?}/piss-ocaml/sessions/$id/worker.sock"
    ${lib.getExe' pkgs.systemd "systemctl"} --user start "$unit"
    for _ in $(seq 1 200); do
      [[ -S "$socket" ]] && exit 0
      ${lib.getExe' pkgs.systemd "systemctl"} --user is-active --quiet "$unit" || {
        ${lib.getExe' pkgs.systemd "systemctl"} --user status "$unit" --no-pager >&2 || true
        exit 1
      }
      sleep .05
    done
    echo "worker socket did not become ready: $socket" >&2
    exit 1
  '';

  stopWorker = pkgs.writeShellScript "piss-ocaml-stop-session" ''
    set -euo pipefail
    id="''${1:?session id required}"
    [[ "$id" =~ ^[a-z0-9-]{3,64}$ ]] || exit 64
    exec ${lib.getExe' pkgs.systemd "systemctl"} --user stop "piss-ocaml-worker@$id.service"
  '';

  workerUpgradeClient = pkgs.writeText "piss-worker-upgrade-client.py" ''
    import json
    import socket
    import sys

    socket_path, operation = sys.argv[1:3]
    request = {"op": operation}
    if operation == "prepare_upgrade":
        request["generation"] = sys.argv[3]

    def receive(connection):
        line = bytearray()
        while not line.endswith(b"\n"):
            chunk = connection.recv(min(65536, 16 * 1024 * 1024 + 1 - len(line)))
            if not chunk:
                raise RuntimeError("worker closed before returning a frame")
            line.extend(chunk)
            if len(line) > 16 * 1024 * 1024:
                raise RuntimeError("worker returned an oversized frame")
        envelope = json.loads(line)
        if not envelope.get("ok"):
            raise RuntimeError(envelope.get("error", "worker request failed"))
        return envelope.get("result")

    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(5)
    connection.connect(socket_path)
    connection.sendall(b'{"op":"hello","protocolVersion":1}\n')
    receive(connection)
    connection.sendall((json.dumps(request, separators=(",", ":")) + "\n").encode())
    print(json.dumps(receive(connection), separators=(",", ":")))
  '';

  upgradeIdleWorkers = pkgs.writeShellScript "piss-ocaml-upgrade-idle-workers" ''
    set -euo pipefail
    runtime_root="''${XDG_RUNTIME_DIR:?}/${serviceStateName}"
    [[ -d "$runtime_root" ]] || exit 0
    target=${lib.escapeShellArg workerGeneration}
    systemctl=${lib.getExe' pkgs.systemd "systemctl"}
    client=${lib.getExe pkgs.python3}
    jq=${lib.getExe pkgs.jq}

    while read -r unit _; do
      [[ -n "$unit" ]] || continue
      id="''${unit#piss-ocaml-worker@}"
      id="''${id%.service}"
      [[ "$id" =~ ^[a-z0-9-]{3,64}$ ]] || continue
      socket="$runtime_root/sessions/$id/worker.sock"
      [[ -S "$socket" ]] || continue
      snapshot="$($client ${workerUpgradeClient} "$socket" snapshot 2>/dev/null)" || continue
      current="$(printf '%s' "$snapshot" | $jq -r '.workerGeneration // ""')"
      [[ "$current" != "$target" ]] || continue
      status="$(printf '%s' "$snapshot" | $jq -r '.status // "offline"')"
      [[ "$status" == idle ]] || continue
      prepared="$($client ${workerUpgradeClient} "$socket" prepare_upgrade "$target" 2>/dev/null)" || {
        echo "worker $id uses a legacy generation without safe upgrade preparation; leaving it running" >&2
        continue
      }
      [[ "$(printf '%s' "$prepared" | $jq -r '.ready // false')" == true ]] || continue
      echo "upgrading idle PISS worker $id from $current to $target"
      $systemctl --user restart "$unit"
      ready=false
      for _ in $(seq 1 300); do
        if [[ -S "$socket" ]]; then
          replacement="$($client ${workerUpgradeClient} "$socket" snapshot 2>/dev/null)" || replacement=""
          if [[ "$(printf '%s' "$replacement" | $jq -r '.workerGeneration // ""')" == "$target" ]]; then
            ready=true
            break
          fi
        fi
        sleep .05
      done
      [[ "$ready" == true ]] || {
        echo "upgraded worker did not become ready: $id" >&2
        exit 1
      }
    done < <($systemctl --user list-units --type=service --state=running --no-legend --plain 'piss-ocaml-worker@*.service')
  '';
  tailscaleStateName = cfg.tailscale.stateName;
  tailscaleSocket = "$XDG_RUNTIME_DIR/${tailscaleStateName}/tailscaled.sock";

  tailscaledRunner = pkgs.writeShellScript "piss-ocaml-tailscaled" ''
    set -euo pipefail
    state="$HOME/.local/state/${tailscaleStateName}/tailscale"
    mkdir -p "$state"
    exec ${lib.getExe' pkgs.tailscale "tailscaled"} \
      --tun=userspace-networking \
      --port=0 \
      --statedir="$state" \
      --socket="${tailscaleSocket}"
  '';

  tailscaleUp = pkgs.writeShellScript "piss-ocaml-tailscale-up" ''
    set -euo pipefail
    state="$(${lib.getExe pkgs.tailscale} --socket="${tailscaleSocket}" status --json 2>/dev/null | ${lib.getExe pkgs.jq} -r '.BackendState // ""' || true)"
    if [[ "$state" == "Running" ]]; then
      exit 0
    fi
    ${
      if cfg.tailscale.authKeyFile != null then
        ''
          exec ${lib.getExe pkgs.tailscale} --socket="${tailscaleSocket}" up \
            --reset \
            --accept-dns=false \
            --hostname=${lib.escapeShellArg cfg.tailscale.hostname} \
            --auth-key=file:${lib.escapeShellArg cfg.tailscale.authKeyFile} \
            --timeout=30s
        ''
      else
        ''
          echo "The OCaml tracer has not joined the tailnet; run piss-ocaml-tailscale-login." >&2
          exit 0
        ''
    }
  '';

  tailscaleServe = pkgs.writeShellScript "piss-ocaml-tailscale-serve" ''
    set -euo pipefail
    state=""
    for _ in $(seq 1 60); do
      state="$(${lib.getExe pkgs.tailscale} --socket="${tailscaleSocket}" status --json 2>/dev/null | ${lib.getExe pkgs.jq} -r '.BackendState // ""' || true)"
      [[ "$state" == "Running" ]] && break
      sleep 1
    done
    [[ "$state" == "Running" ]] || { echo "The OCaml tracer Tailscale node is not authenticated." >&2; exit 1; }
    exec ${lib.getExe pkgs.tailscale} --socket="${tailscaleSocket}" serve --bg --yes \
      http://127.0.0.1:${toString cfg.port}
  '';

  loginTool = pkgs.writeShellScriptBin "piss-ocaml-tailscale-login" ''
    set -euo pipefail
    socket="''${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/${tailscaleStateName}/tailscaled.sock"
    ${lib.getExe pkgs.tailscale} --socket="$socket" up \
      --reset \
      --accept-dns=false \
      --hostname=${lib.escapeShellArg cfg.tailscale.hostname}
    systemctl --user restart piss-ocaml-tailscale-up.service piss-ocaml-tailscale-serve.service
  '';
in
{
  options.services.piss-next = {
    enable = lib.mkEnableOption "the OCaml PISS replaceability tracer";

    package = lib.mkOption {
      type = lib.types.package;
      default = nativePackage;
      defaultText = lib.literalExpression "inputs.piss-ocaml.packages.\${system}.piss-next-native";
      description = "Combined OCaml development package retained for compatibility.";
    };

    controlPackage = lib.mkOption {
      type = lib.types.package;
      default = controlPackage;
      defaultText = lib.literalExpression "inputs.piss-ocaml.packages.\${system}.piss-next-control";
      description = "Replaceable OCaml control-plane package.";
    };

    workerPackage = lib.mkOption {
      type = lib.types.package;
      default = workerPackage;
      defaultText = lib.literalExpression "inputs.piss-ocaml.packages.\${system}.piss-next-worker";
      description = "Stable independently supervised session-worker package.";
    };

    mockAgentPackage = lib.mkOption {
      type = lib.types.package;
      default = mockAgentPackage;
      defaultText = lib.literalExpression "inputs.piss-ocaml.packages.\${system}.piss-next-mock-agent";
      description = "Deterministic ACP fixture package used by mock sessions.";
    };

    sessionMcpPackage = lib.mkOption {
      type = lib.types.package;
      default = sessionMcpPackage;
      defaultText = lib.literalExpression "inputs.piss-ocaml.packages.\${system}.piss-next-session-mcp";
      description = "Harness-neutral MCP server for inter-session collaboration.";
    };

    webPackage = lib.mkOption {
      type = lib.types.package;
      default = webPackage;
      defaultText = lib.literalExpression "inputs.piss-ocaml.packages.\${system}.piss-next-web";
      description = "Reason/Melange browser package.";
    };

    adapterPackage = lib.mkOption {
      type = lib.types.package;
      default = defaultAdapterPackage;
      defaultText = lib.literalExpression "inputs.piss-ocaml.packages.\${system}.pi-acp";
      description = "Pinned Pi ACP adapter package.";
    };

    opencodePackage = lib.mkOption {
      type = lib.types.package;
      default = defaultOpenCodePackage;
      defaultText = lib.literalExpression "inputs.piss-ocaml.packages.\${system}.opencode";
      description = "Pinned OpenCode package with its native ACP server.";
    };

    opencodeAuthFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/home/agent/.local/share/opencode/auth.json";
      description = ''
        Optional runtime OpenCode auth.json source. OpenCode workers copy a newer
        source into their private XDG data directory before starting, without
        placing credentials in the Nix store or process environment.
      '';
    };

    harness = lib.mkOption {
      type = lib.types.enum [
        "pi"
        "opencode"
        "mock"
      ];
      default = "pi";
      description = "ACP harness used by the deployed session worker.";
    };

    piCommand = lib.mkOption {
      type = lib.types.str;
      default = "pi";
      description = "Absolute Pi CLI path used by pi-acp.";
    };

    environmentFiles = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Absolute systemd EnvironmentFile paths containing model provider credentials.";
    };

    sshAgentSocket = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "SSH agent socket inherited by the real agent worker.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 4318;
      description = "Loopback port for the replaceable OCaml control plane.";
    };

    maxActiveSessions = lib.mkOption {
      type = lib.types.ints.between 1 256;
      default = 32;
      description = "Resource safety limit for concurrently active harness sessions.";
    };

    autoUpgradeIdleWorkers = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Automatically move active session workers to the current immutable
        generation after each worker atomically confirms that it is idle.
      '';
    };

    workerUpgradeInterval = lib.mkOption {
      type = lib.types.str;
      default = "1min";
      example = "30s";
      description = "systemd time span between idle-worker upgrade checks.";
    };

    workspace = lib.mkOption {
      type = lib.types.str;
      default = "/home/jonas/coding/piss-ocaml";
      description = "Backward-compatible default workspace used when workspaces is empty.";
    };

    workspaces = lib.mkOption {
      default = { };
      description = "Allowlisted workspaces available to durable sessions.";
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            name = lib.mkOption { type = lib.types.str; };
            path = lib.mkOption { type = lib.types.str; };
          };
        }
      );
    };

    workspaceDiscoveryRoots = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Local directory roots available to the workspace picker.";
    };

    allowedUsers = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Tailscale user logins authorized to use the agent control plane.";
    };

    tailscale = {
      enable = lib.mkEnableOption "an independent userspace Tailscale node for the OCaml tracer" // {
        default = true;
      };

      hostname = lib.mkOption {
        type = lib.types.str;
        default = "piss-ocaml";
        description = "Tailnet hostname for the OCaml tracer.";
      };

      allowedOrigins = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ "https://${cfg.tailscale.hostname}.*.ts.net" ];
        defaultText = lib.literalExpression
          "[ \"https://\''${cfg.tailscale.hostname}.*.ts.net\" ]";
        description = ''
          Origin URL patterns the control plane accepts on state-changing
          requests in addition to the loopback URL. The default is a
          glob-style pattern that matches every Tailscale Serve URL for
          this node (`https://<tailscale.hostname>.<tailnet>.ts.net`)
          without the module having to know the tailnet. Add more
          entries when routing through another reverse proxy.
        '';
      };

      stateName = lib.mkOption {
        type = lib.types.strMatching "[a-zA-Z0-9_-]+";
        default = "piss-ocaml-tailscale";
        description = "Independent Tailscale state and runtime directory name.";
      };

      authKeyFile = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Optional file containing a Tailscale auth key.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = lib.all (workspace: lib.hasPrefix "/" workspace.path) workspaceEntries;
        message = "services.piss-next workspace paths must be absolute";
      }
      {
        assertion = lib.all (path: lib.hasPrefix "/" path) cfg.workspaceDiscoveryRoots;
        message = "services.piss-next.workspaceDiscoveryRoots entries must be absolute";
      }
      {
        assertion = lib.all (
          workspace:
          !(
            lib.hasInfix "|" workspace.id || lib.hasInfix "|" workspace.name || lib.hasInfix "|" workspace.path
          )
        ) workspaceEntries;
        message = "services.piss-next workspace fields must not contain |";
      }
      {
        assertion = cfg.allowedUsers != [ ];
        message = "services.piss-next.allowedUsers must contain at least one Tailscale login";
      }
      {
        assertion = cfg.harness != "pi" || lib.hasPrefix "/" cfg.piCommand;
        message = "services.piss-next.piCommand must be absolute for the Pi harness";
      }
      {
        assertion = cfg.opencodeAuthFile == null || lib.hasPrefix "/" cfg.opencodeAuthFile;
        message = "services.piss-next.opencodeAuthFile must be absolute";
      }
      {
        assertion = lib.all (path: lib.hasPrefix "/" path) cfg.environmentFiles;
        message = "services.piss-next.environmentFiles entries must be absolute";
      }
      {
        assertion = cfg.sshAgentSocket == null || lib.hasPrefix "/" cfg.sshAgentSocket;
        message = "services.piss-next.sshAgentSocket must be absolute";
      }
      {
        assertion = cfg.tailscale.authKeyFile == null || lib.hasPrefix "/" cfg.tailscale.authKeyFile;
        message = "services.piss-next.tailscale.authKeyFile must be absolute";
      }
    ];

    environment.systemPackages = [
      cfg.controlPackage
      cfg.workerPackage
    ]
    ++ lib.optional cfg.tailscale.enable loginTool;

    systemd.user.services."piss-ocaml-worker@" = {
      description = "PISS OCaml independently supervised worker for session %i";
      restartIfChanged = false;
      stopIfChanged = false;
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      serviceConfig = {
        ExecStart = "${workerRunner} %i";
        EnvironmentFile = cfg.environmentFiles;
        Restart = "on-failure";
        RestartSec = 2;
        RuntimeDirectory = "${serviceStateName}/sessions/%i";
        RuntimeDirectoryMode = "0700";
        StateDirectory = "${serviceStateName}/sessions/%i";
        StateDirectoryMode = "0700";
        UMask = "0077";
        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        ProtectHome = "read-only";
        ProtectSystem = "strict";
        ReadWritePaths = [
          "%S/${serviceStateName}/sessions/%i"
          "-%h/.pi"
        ]
        ++ workspacePaths
        ++ cfg.workspaceDiscoveryRoots;
        LockPersonality = true;
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
      };
      environment = {
        PI_ACP_ENABLE_EMBEDDED_CONTEXT = "true";
        PI_ACP_PI_COMMAND = cfg.piCommand;
      }
      // lib.optionalAttrs (cfg.sshAgentSocket != null) {
        PISS_SSH_AUTH_SOCK = cfg.sshAgentSocket;
        SSH_AUTH_SOCK = cfg.sshAgentSocket;
      };
    };

    systemd.user.services.piss-ocaml = {
      description = "PISS OCaml replaceable control plane";
      wantedBy = [ "default.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      serviceConfig = {
        ExecStart = lib.escapeShellArgs (
          [
            "${cfg.controlPackage}/bin/pissd-next"
            "--port"
            (toString cfg.port)
            "--registry"
            "${stateDirectory}/registry.sqlite3"
            "--session-state-root"
            sessionStateRoot
            "--session-runtime-root"
            sessionRuntimeRoot
            "--session-launcher"
            startWorker
            "--session-stopper"
            stopWorker
            "--available-harness"
            "pi"
            "--available-harness"
            "opencode"
            "--available-harness"
            "mock"
            "--default-harness"
            cfg.harness
            "--bootstrap-session"
            "deployed-tracer"
            "--max-active-sessions"
            (toString cfg.maxActiveSessions)
            "--public"
            "${cfg.webPackage}/share/piss-next/public"
            "--app-js"
            "${cfg.webPackage}/share/piss-next/public/app.js"
            "--generation"
            (toString cfg.controlPackage)
          ]
          ++ workspaceArguments
          ++ workspaceDiscoveryArguments
          ++ lib.concatMap (user: [
            "--allowed-user"
            user
          ]) cfg.allowedUsers
          ++ lib.concatMap (origin: [
            "--allowed-origin"
            origin
          ]) cfg.tailscale.allowedOrigins
        );
        Restart = "always";
        RestartSec = 2;
        StateDirectory = serviceStateName;
        StateDirectoryMode = "0700";
        ReadWritePaths = [ stateDirectory ];
        UMask = "0077";
        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        # The worker socket lives under %t (/run/user/$UID), so the control
        # plane needs read-only traversal of the user runtime directory.
        ProtectHome = "read-only";
        ProtectSystem = "strict";
        LockPersonality = true;
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
      };
    };

    systemd.user.services.piss-ocaml-watchdog = {
      description = "Ensure PISS OCaml control plane is running";
      after = [ "piss-ocaml.service" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${lib.getExe' pkgs.systemd "systemctl"} --user start piss-ocaml.service";
        UMask = "0077";
        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        ProtectHome = "read-only";
        ProtectSystem = "strict";
        LockPersonality = true;
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
      };
    };

    systemd.user.timers.piss-ocaml-watchdog = {
      description = "Periodically confirm PISS OCaml control plane";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "30s";
        OnUnitActiveSec = "1min";
        Persistent = true;
        Unit = "piss-ocaml-watchdog.service";
      };
    };

    systemd.user.services.piss-ocaml-worker-upgrade = lib.mkIf cfg.autoUpgradeIdleWorkers {
      description = "Upgrade idle PISS workers to the current immutable generation";
      after = [ "piss-ocaml.service" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = upgradeIdleWorkers;
        UMask = "0077";
        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        ProtectHome = "read-only";
        ProtectSystem = "strict";
        RestrictAddressFamilies = [ "AF_UNIX" ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
      };
    };

    systemd.user.timers.piss-ocaml-worker-upgrade = lib.mkIf cfg.autoUpgradeIdleWorkers {
      description = "Periodically upgrade idle PISS workers";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "30s";
        OnUnitActiveSec = cfg.workerUpgradeInterval;
        Persistent = true;
        Unit = "piss-ocaml-worker-upgrade.service";
      };
    };

    systemd.user.services.piss-ocaml-tailscaled = lib.mkIf cfg.tailscale.enable {
      description = "Independent userspace Tailscale node for PISS OCaml";
      wantedBy = [ "default.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      serviceConfig = {
        ExecStart = tailscaledRunner;
        Restart = "on-failure";
        RestartSec = 3;
        RuntimeDirectory = tailscaleStateName;
        RuntimeDirectoryMode = "0700";
        StateDirectory = tailscaleStateName;
        StateDirectoryMode = "0700";
        UMask = "0077";
        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        ProtectHome = "read-only";
        ProtectSystem = "strict";
        ReadWritePaths = [ "%S/${tailscaleStateName}" ];
        LockPersonality = true;
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_NETLINK"
          "AF_UNIX"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
      };
    };

    systemd.user.services.piss-ocaml-tailscale-up = lib.mkIf cfg.tailscale.enable {
      description = "Authenticate the independent PISS OCaml Tailscale node";
      wantedBy = [ "default.target" ];
      after = [ "piss-ocaml-tailscaled.service" ];
      requires = [ "piss-ocaml-tailscaled.service" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = tailscaleUp;
        RemainAfterExit = true;
      };
    };

    systemd.user.services.piss-ocaml-tailscale-serve = lib.mkIf cfg.tailscale.enable {
      description = "Serve PISS OCaml at ${cfg.tailscale.hostname}.<tailnet>.ts.net";
      wantedBy = [ "default.target" ];
      after = [
        "piss-ocaml.service"
        "piss-ocaml-tailscaled.service"
        "piss-ocaml-tailscale-up.service"
      ];
      requires = [
        "piss-ocaml.service"
        "piss-ocaml-tailscaled.service"
      ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = tailscaleServe;
        RemainAfterExit = true;
        Restart = "on-failure";
        RestartSec = 15;
      };
    };
  };
}
