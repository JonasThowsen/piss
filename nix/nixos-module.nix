self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.piss;
  package = self.packages.${pkgs.stdenv.hostPlatform.system}.piss;
  adapterPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-acp;
  opencodePackage = self.packages.${pkgs.stdenv.hostPlatform.system}.opencode;
  codexAcpPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.codex-acp;
  stateName = "piss-ocaml";
  runtimeDirectory = "%t/${stateName}";
  stateDirectory = "%S/${stateName}";
  sessionRuntimeRoot = "${runtimeDirectory}/sessions";
  sessionStateRoot = "${stateDirectory}/sessions";
  effectiveWorkspaces = cfg.workspaces;
  workspaceEntries = lib.mapAttrsToList (id: value: value // { inherit id; }) effectiveWorkspaces;
  workspacePaths = map (workspace: workspace.path) workspaceEntries;
  workspaceArguments = lib.concatMap (workspace: [
    "--workspace-spec"
    "${workspace.id}|${workspace.name}|${workspace.path}"
  ]) workspaceEntries;
  workspaceDiscoveryArguments = lib.concatMap (path: [
    "--workspace-discovery-root"
    path
  ]) cfg.workspaceDiscoveryRoots;
  safeSystemdValue =
    value: !(lib.hasInfix "%" value || lib.hasInfix "\n" value || lib.hasInfix "\r" value);
  workerGeneration = builtins.hashString "sha256" (
    lib.concatStringsSep "\n" (
      map toString [
        cfg.package
        cfg.adapterPackage
        cfg.opencodePackage
        cfg.codexAcpPackage
      ]
      ++ [
        cfg.piCommand
        (if cfg.codexAuthFile == null then "" else cfg.codexAuthFile)
        (if cfg.opencodeAuthFile == null then "" else cfg.opencodeAuthFile)
        (if cfg.sshAgentSocket == null then "" else cfg.sshAgentSocket)
        (toString cfg.port)
        (builtins.toJSON cfg.environmentFiles)
        (builtins.toJSON workspacePaths)
        (builtins.toJSON cfg.workspaceDiscoveryRoots)
        (builtins.readFile ./nixos-module.nix)
      ]
    )
  );

  workerRunner = pkgs.writeShellScript "piss-session-worker" ''
    set -euo pipefail
    unset XDG_STATE_HOME XDG_CACHE_HOME XDG_CONFIG_HOME XDG_DATA_HOME
    id="''${1:?session id required}"
    [[ "$id" =~ ^[a-z0-9-]{3,64}$ ]] || { echo "invalid session id" >&2; exit 64; }

    session_state="''${STATE_DIRECTORY:?}"
    session_runtime="''${RUNTIME_DIRECTORY:?}"
    state="''${session_state%/sessions/$id}"
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
        [[ ! -e "$state/worker.sqlite3$suffix" ]] || cp -p "$state/worker.sqlite3$suffix" "$session_state/.worker.sqlite3$suffix.migrating"
      done
      for suffix in -wal -shm ""; do
        [[ ! -e "$session_state/.worker.sqlite3$suffix.migrating" ]] || mv "$session_state/.worker.sqlite3$suffix.migrating" "$session_state/worker.sqlite3$suffix"
      done
    fi
    case "$harness" in
      pi)
        command=${lib.escapeShellArg "${cfg.adapterPackage}/bin/pi-acp"}
        args=()
        ;;
      codex)
        codex_home="$session_state/codex"
        mkdir -p "$codex_home"
        auth_source=${lib.escapeShellArg (if cfg.codexAuthFile == null then "" else cfg.codexAuthFile)}
        if [[ -z "$auth_source" && -f "$HOME/.codex/auth.json" ]]; then
          auth_source="$HOME/.codex/auth.json"
        fi
        if [[ -n "$auth_source" ]]; then
          [[ -f "$auth_source" ]] || {
            echo "configured Codex authentication file is missing" >&2
            exit 78
          }
          ${lib.getExe pkgs.jq} -e 'type == "object"' "$auth_source" >/dev/null || {
            echo "configured Codex authentication file must contain a JSON object" >&2
            exit 78
          }
          ${lib.getExe' pkgs.coreutils "install"} -m 0600 "$auth_source" "$codex_home/.auth.json.new"
          mv -f "$codex_home/.auth.json.new" "$codex_home/auth.json"
        else
          rm -f "$codex_home/.auth.json.new" "$codex_home/auth.json"
          if [[ -n "''${CODEX_API_KEY:-}''${OPENAI_API_KEY:-}" ]]; then
            export DEFAULT_AUTH_REQUEST='{"methodId":"api-key"}'
          fi
        fi
        export CODEX_HOME="$codex_home"
        export NO_BROWSER=1
        command=${lib.escapeShellArg "${cfg.codexAcpPackage}/bin/codex-acp"}
        args=()
        ;;
      opencode)
        auth_source=${
          lib.escapeShellArg (if cfg.opencodeAuthFile == null then "" else cfg.opencodeAuthFile)
        }
        if [[ -n "$auth_source" ]]; then
          [[ -f "$auth_source" ]] || {
            echo "configured OpenCode authentication file is missing" >&2
            exit 78
          }
          auth_dir="$session_state/data/opencode"
          auth_target="$auth_dir/auth.json"
          ${lib.getExe pkgs.jq} -e 'type == "object"' "$auth_source" >/dev/null || {
            echo "configured OpenCode authentication file must contain a JSON object" >&2
            exit 78
          }
          mkdir -p "$auth_dir"
          ${lib.getExe' pkgs.coreutils "install"} -m 0600 "$auth_source" "$auth_target"
        fi
        user_config="$HOME/.config/opencode"
        if [[ -d "$user_config" ]]; then
          session_config="$session_state/config/opencode"
          mkdir -p "$session_config"
          ${lib.getExe' pkgs.rsync "rsync"} -a --update --delete --exclude='.git' \
            "$user_config/" "$session_config/"
        fi
        command=${lib.escapeShellArg "${cfg.opencodePackage}/bin/opencode"}
        args=(--harness-arg acp)
        ;;
      mock)
        command=${lib.escapeShellArg "${cfg.package}/bin/piss-mock-agent"}
        args=()
        ;;
      *)
        echo "unsupported harness: $harness" >&2
        exit 64
        ;;
    esac

    exec ${cfg.package}/bin/piss-session-worker \
      --socket "$session_runtime/worker.sock" \
      --database "$session_state/worker.sqlite3" \
      --session "$id" \
      --worker "worker-$id" \
      --generation ${lib.escapeShellArg workerGeneration} \
      --workspace "$workspace" \
      --harness "$command" \
      --session-mcp ${cfg.package}/bin/piss-session-mcp \
      --broker-url http://127.0.0.1:${toString cfg.port} \
      --broker-token "$broker_token" \
      --curl-command ${lib.getExe pkgs.curl} \
      "''${args[@]}"
  '';

  startWorker = pkgs.writeShellScript "piss-start-session" ''
    set -euo pipefail
    id="''${1:?session id required}"
    [[ "$id" =~ ^[a-z0-9-]{3,64}$ ]] || exit 64
    unit="piss-ocaml-worker@$id.service"
    socket="''${XDG_RUNTIME_DIR:?}/${stateName}/sessions/$id/worker.sock"
    ${lib.getExe' pkgs.systemd "systemctl"} --user start "$unit"
    # Pi may spend tens of seconds loading its provider and MCP catalog before
    # the worker can expose the ready socket. Keep the lifecycle request
    # bounded, but do not misclassify a healthy cold start as failed.
    for _ in $(seq 1 1200); do
      [[ -S "$socket" ]] && exit 0
      ${lib.getExe' pkgs.systemd "systemctl"} --user is-active --quiet "$unit" || {
        ${lib.getExe' pkgs.systemd "systemctl"} --user status "$unit" --no-pager >&2 || true
        exit 1
      }
      sleep .05
    done
    echo "worker socket did not become ready after 60 seconds: $socket" >&2
    exit 1
  '';

  stopWorker = pkgs.writeShellScript "piss-stop-session" ''
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

    def connect(version):
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(5)
        connection.connect(socket_path)
        connection.sendall((json.dumps({"op": "hello", "protocolVersion": version}, separators=(",", ":")) + "\n").encode())
        receive(connection)
        return connection

    try:
        connection = connect(2)
    except Exception:
        # Read-only snapshots and idle upgrade preparation remain available for
        # immutable protocol-v1 workers while the new control plane rolls out.
        connection = connect(1)
    connection.sendall((json.dumps(request, separators=(",", ":")) + "\n").encode())
    print(json.dumps(receive(connection), separators=(",", ":")))
  '';

  upgradeIdleWorkers = pkgs.writeShellScript "piss-upgrade-idle-workers" ''
    set -euo pipefail
    runtime_root="''${XDG_RUNTIME_DIR:?}/${stateName}"
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
        echo "worker $id cannot prepare for a safe upgrade; leaving it running" >&2
        continue
      }
      [[ "$(printf '%s' "$prepared" | $jq -r '.ready // false')" == true ]] || continue
      echo "upgrading idle Piss worker $id from $current to $target"
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

  tailscaleSocket = "$XDG_RUNTIME_DIR/${cfg.tailscale.stateName}/tailscaled.sock";
  tailscaledRunner = pkgs.writeShellScript "piss-tailscaled" ''
    set -euo pipefail
    state="''${STATE_DIRECTORY:?}/tailscale"
    mkdir -p "$state"
    exec ${lib.getExe' pkgs.tailscale "tailscaled"} \
      --tun=userspace-networking \
      --port=0 \
      --statedir="$state" \
      --socket="''${RUNTIME_DIRECTORY:?}/tailscaled.sock"
  '';
  tailscaleUp = pkgs.writeShellScript "piss-tailscale-up" ''
    set -euo pipefail
    state=""
    for _ in $(seq 1 60); do
      state="$(${lib.getExe pkgs.tailscale} --socket="${tailscaleSocket}" status --json 2>/dev/null | ${lib.getExe pkgs.jq} -r '.BackendState // ""' || true)"
      if [[ "$state" == "Running" ]]; then
        exec ${lib.getExe pkgs.tailscale} --socket="${tailscaleSocket}" set \
          --accept-dns=false \
          --hostname=${lib.escapeShellArg cfg.tailscale.hostname}
      fi
      sleep .5
    done
    ${
      if cfg.tailscale.authKeyFile == null then
        ''
          echo "Piss has not joined the tailnet (backend state: $state); run piss-tailscale-login." >&2
          exit 1
        ''
      else
        ''
          exec ${lib.getExe pkgs.tailscale} --socket="${tailscaleSocket}" up \
            --reset \
            --accept-dns=false \
            --hostname=${lib.escapeShellArg cfg.tailscale.hostname} \
            --auth-key=file:${lib.escapeShellArg cfg.tailscale.authKeyFile} \
            --timeout=30s
        ''
    }
  '';
  tailscaleServe = pkgs.writeShellScript "piss-tailscale-serve" ''
    set -euo pipefail
    state=""
    for _ in $(seq 1 60); do
      state="$(${lib.getExe pkgs.tailscale} --socket="${tailscaleSocket}" status --json 2>/dev/null | ${lib.getExe pkgs.jq} -r '.BackendState // ""' || true)"
      [[ "$state" == "Running" ]] && break
      sleep 1
    done
    [[ "$state" == "Running" ]] || { echo "The Piss Tailscale node is not authenticated." >&2; exit 1; }
    exec ${lib.getExe pkgs.tailscale} --socket="${tailscaleSocket}" serve --bg --yes \
      http://127.0.0.1:${toString cfg.port}
  '';
  loginTool = pkgs.writeShellScriptBin "piss-tailscale-login" ''
    set -euo pipefail
    socket="''${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/${cfg.tailscale.stateName}/tailscaled.sock"
    ${lib.getExe pkgs.tailscale} --socket="$socket" up \
      --reset \
      --accept-dns=false \
      --hostname=${lib.escapeShellArg cfg.tailscale.hostname}
    systemctl --user restart piss-ocaml-tailscale-up.service piss-ocaml-tailscale-serve.service
  '';
in
{
  options.services.piss = {
    enable = lib.mkEnableOption "the Piss coding-agent control plane";
    package = lib.mkOption {
      type = lib.types.package;
      default = package;
      defaultText = lib.literalExpression "inputs.piss.packages.\${system}.piss";
      description = "Piss native server, worker, mock agent, MCP server, and browser package.";
    };
    adapterPackage = lib.mkOption {
      type = lib.types.package;
      default = adapterPackage;
      defaultText = lib.literalExpression "inputs.piss.packages.\${system}.pi-acp";
      description = "Pinned Pi ACP adapter package.";
    };
    opencodePackage = lib.mkOption {
      type = lib.types.package;
      default = opencodePackage;
      defaultText = lib.literalExpression "inputs.piss.packages.\${system}.opencode";
      description = "Pinned OpenCode package with its native ACP server.";
    };
    codexAcpPackage = lib.mkOption {
      type = lib.types.package;
      default = codexAcpPackage;
      defaultText = lib.literalExpression "inputs.piss.packages.\${system}.codex-acp";
      description = "Pinned ACP adapter package for OpenAI Codex.";
    };
    codexAuthFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Optional Codex auth.json source outside the Nix store; defaults to ~/.codex/auth.json when present.";
    };
    opencodeAuthFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Optional runtime OpenCode auth.json source outside the Nix store.";
    };
    harness = lib.mkOption {
      type = lib.types.enum [
        "pi"
        "codex"
        "opencode"
        "mock"
      ];
      default = "pi";
      description = "Default ACP harness for new sessions.";
    };
    piCommand = lib.mkOption {
      type = lib.types.str;
      example = lib.literalExpression "lib.getExe pkgs.pi-coding-agent";
      description = ''
        Absolute, preferably store-backed Pi CLI path used by pi-acp. The
        selected Pi installation must provide the MCP adapter extension and
        its --mcp-config option.
      '';
    };
    environmentFiles = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Systemd EnvironmentFile paths containing model-provider credentials.";
    };
    sshAgentSocket = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "SSH agent socket inherited by session workers.";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 4318;
      description = "Loopback port for the Piss control plane.";
    };
    maxActiveSessions = lib.mkOption {
      type = lib.types.ints.between 1 256;
      default = 32;
      description = "Maximum number of concurrently active harness sessions.";
    };
    autoUpgradeIdleWorkers = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Safely restart idle workers when their immutable generation changes.";
    };
    workerUpgradeInterval = lib.mkOption {
      type = lib.types.str;
      default = "1min";
      description = "Systemd time span between idle-worker upgrade checks.";
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
      description = "Local roots available to the workspace picker.";
    };
    allowedUsers = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Tailscale user logins authorized to use Piss.";
    };
    tailscale = {
      enable = lib.mkEnableOption "an independent userspace Tailscale node for Piss" // {
        default = true;
      };
      hostname = lib.mkOption {
        type = lib.types.str;
        default = "piss";
        description = "Tailnet hostname for Piss.";
      };
      allowedOrigins = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ "https://${cfg.tailscale.hostname}.*.ts.net" ];
        description = "Origin patterns accepted for state-changing requests.";
      };
      stateName = lib.mkOption {
        type = lib.types.strMatching "[a-zA-Z0-9_-]+";
        default = "piss-tailscale";
        description = "Tailscale state and runtime directory name.";
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
        assertion = workspaceEntries != [ ];
        message = "services.piss.workspaces must contain at least one workspace";
      }
      {
        assertion = lib.all (workspace: lib.hasPrefix "/" workspace.path) workspaceEntries;
        message = "services.piss workspace paths must be absolute";
      }
      {
        assertion = lib.all (path: lib.hasPrefix "/" path) cfg.workspaceDiscoveryRoots;
        message = "services.piss.workspaceDiscoveryRoots entries must be absolute";
      }
      {
        assertion = lib.all (
          workspace:
          builtins.match "[a-z0-9-]{3,64}" workspace.id != null
          && builtins.stringLength workspace.name >= 1
          && builtins.stringLength workspace.name <= 120
          && builtins.match ".*[^ 	\n\r].*" workspace.name != null
          && !(
            lib.hasInfix "|" workspace.id
            || lib.hasInfix "|" workspace.name
            || lib.hasInfix "|" workspace.path
            || lib.hasInfix "%" workspace.id
            || lib.hasInfix "%" workspace.name
            || lib.hasInfix "%" workspace.path
            || lib.hasInfix "\n" workspace.id
            || lib.hasInfix "\n" workspace.name
            || lib.hasInfix "\n" workspace.path
            || lib.hasInfix "\r" workspace.id
            || lib.hasInfix "\r" workspace.name
            || lib.hasInfix "\r" workspace.path
          )
        ) workspaceEntries;
        message = "services.piss workspace IDs or names are invalid, or fields contain |, %, or newlines";
      }
      {
        assertion = lib.all safeSystemdValue (
          cfg.workspaceDiscoveryRoots
          ++ cfg.allowedUsers
          ++ cfg.tailscale.allowedOrigins
          ++ cfg.environmentFiles
          ++ [ cfg.piCommand ]
          ++ lib.optional (cfg.codexAuthFile != null) cfg.codexAuthFile
          ++ lib.optional (cfg.opencodeAuthFile != null) cfg.opencodeAuthFile
          ++ lib.optional (cfg.sshAgentSocket != null) cfg.sshAgentSocket
          ++ lib.optional (cfg.tailscale.authKeyFile != null) cfg.tailscale.authKeyFile
        );
        message = "services.piss systemd arguments must not contain %, carriage returns, or newlines";
      }
      {
        assertion = cfg.allowedUsers != [ ];
        message = "services.piss.allowedUsers must contain at least one Tailscale login";
      }
      {
        assertion = cfg.harness != "pi" || lib.hasPrefix "/" cfg.piCommand;
        message = "services.piss.piCommand must be absolute for the Pi harness";
      }
      {
        assertion = cfg.codexAuthFile == null || lib.hasPrefix "/" cfg.codexAuthFile;
        message = "services.piss.codexAuthFile must be absolute";
      }
      {
        assertion = cfg.opencodeAuthFile == null || lib.hasPrefix "/" cfg.opencodeAuthFile;
        message = "services.piss.opencodeAuthFile must be absolute";
      }
      {
        assertion = lib.all (path: lib.hasPrefix "/" path) cfg.environmentFiles;
        message = "services.piss.environmentFiles entries must be absolute";
      }
      {
        assertion = cfg.sshAgentSocket == null || lib.hasPrefix "/" cfg.sshAgentSocket;
        message = "services.piss.sshAgentSocket must be absolute";
      }
      {
        assertion = cfg.tailscale.authKeyFile == null || lib.hasPrefix "/" cfg.tailscale.authKeyFile;
        message = "services.piss.tailscale.authKeyFile must be absolute";
      }
    ];

    environment.systemPackages = [ cfg.package ] ++ lib.optional cfg.tailscale.enable loginTool;

    systemd.user.services."piss-ocaml-worker@" = {
      description = "Piss independently supervised worker for session %i";
      restartIfChanged = false;
      stopIfChanged = false;
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      path = [ pkgs.coreutils ];
      serviceConfig = {
        ExecStart = "${workerRunner} %i";
        EnvironmentFile = cfg.environmentFiles;
        Restart = "on-failure";
        RestartSec = 2;
        RuntimeDirectory = "${stateName}/sessions/%i";
        RuntimeDirectoryMode = "0700";
        StateDirectory = "${stateName}/sessions/%i";
        StateDirectoryMode = "0700";
        UMask = "0077";
        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        ProtectHome = "read-only";
        ProtectSystem = "strict";
        ReadWritePaths = [
          "%S/${stateName}/sessions/%i"
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
      description = "Piss coding-agent control plane";
      wantedBy = [ "default.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      serviceConfig = {
        ExecStart = lib.escapeShellArgs (
          [
            "${cfg.package}/bin/pissd"
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
            "codex"
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
            "${cfg.package}/share/piss/public"
            "--app-js"
            "${cfg.package}/share/piss/public/app.js"
            "--generation"
            (toString cfg.package)
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
        StateDirectory = stateName;
        StateDirectoryMode = "0700";
        ReadWritePaths = [ stateDirectory ];
        UMask = "0077";
        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
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

    systemd.user.services.piss-ocaml-worker-upgrade = lib.mkIf cfg.autoUpgradeIdleWorkers {
      description = "Upgrade idle Piss workers to the current immutable generation";
      wantedBy = [ "default.target" ];
      after = [ "piss-ocaml.service" ];
      path = [ pkgs.coreutils ];
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
      description = "Periodically upgrade idle Piss workers";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "30s";
        OnUnitActiveSec = cfg.workerUpgradeInterval;
        Persistent = true;
        Unit = "piss-ocaml-worker-upgrade.service";
      };
    };

    systemd.user.services.piss-ocaml-tailscaled = lib.mkIf cfg.tailscale.enable {
      description = "Independent userspace Tailscale node for Piss";
      wantedBy = [ "default.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      serviceConfig = {
        ExecStart = tailscaledRunner;
        Restart = "on-failure";
        RestartSec = 3;
        RuntimeDirectory = cfg.tailscale.stateName;
        RuntimeDirectoryMode = "0700";
        StateDirectory = cfg.tailscale.stateName;
        StateDirectoryMode = "0700";
        ReadWritePaths = [ "%S/${cfg.tailscale.stateName}" ];
        UMask = "0077";
        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        ProtectHome = "read-only";
        ProtectSystem = "strict";
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
      description = "Authenticate the independent Piss Tailscale node";
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
      description = "Serve Piss through Tailscale";
      wantedBy = [ "default.target" ];
      after = [
        "piss-ocaml.service"
        "piss-ocaml-tailscaled.service"
        "piss-ocaml-tailscale-up.service"
      ];
      requires = [
        "piss-ocaml.service"
        "piss-ocaml-tailscaled.service"
        "piss-ocaml-tailscale-up.service"
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
