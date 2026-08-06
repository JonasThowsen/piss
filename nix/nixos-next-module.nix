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
  webPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.piss-next-web;
  defaultAdapterPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-acp;
  defaultOpenCodePackage = self.packages.${pkgs.stdenv.hostPlatform.system}.opencode;
  serviceStateName = "piss-ocaml";
  runtimeDirectory = "%t/${serviceStateName}";
  stateDirectory = "%S/${serviceStateName}";
  sessionRuntimeRoot = "${runtimeDirectory}/sessions";
  sessionStateRoot = "${stateDirectory}/sessions";

  workerRunner = pkgs.writeShellScript "piss-ocaml-session-worker" ''
    set -euo pipefail
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
        command=${lib.escapeShellArg "${cfg.opencodePackage}/bin/opencode"}
        args=(--harness-arg acp)
        ;;
      mock)
        command=${lib.escapeShellArg "${cfg.package}/bin/piss-mock-agent"}
        args=()
        ;;
      *) echo "unsupported harness: $harness" >&2; exit 64 ;;
    esac
    exec ${cfg.package}/bin/piss-session-worker \
      --socket "$session_runtime/worker.sock" \
      --database "$session_state/worker.sqlite3" \
      --session "$id" \
      --worker "worker-$id" \
      --workspace ${lib.escapeShellArg cfg.workspace} \
      --harness "$command" \
      "''${args[@]}"
  '';

  startWorker = pkgs.writeShellScript "piss-ocaml-start-session" ''
    set -euo pipefail
    id="''${1:?session id required}"
    [[ "$id" =~ ^[a-z0-9-]{3,64}$ ]] || exit 64
    exec ${lib.getExe' pkgs.systemd "systemctl"} --user start "piss-ocaml-worker@$id.service"
  '';

  stopWorker = pkgs.writeShellScript "piss-ocaml-stop-session" ''
    set -euo pipefail
    id="''${1:?session id required}"
    [[ "$id" =~ ^[a-z0-9-]{3,64}$ ]] || exit 64
    exec ${lib.getExe' pkgs.systemd "systemctl"} --user stop "piss-ocaml-worker@$id.service"
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
      description = "OCaml control-plane, session-worker, and ACP mock-agent package.";
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

    workspace = lib.mkOption {
      type = lib.types.str;
      default = "/home/jonas/coding/piss-ocaml";
      description = "Authorized workspace passed to the tracer ACP session.";
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
        assertion = lib.hasPrefix "/" cfg.workspace;
        message = "services.piss-next.workspace must be absolute";
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

    environment.systemPackages = [ cfg.package ] ++ lib.optional cfg.tailscale.enable loginTool;

    systemd.user.services."piss-ocaml-worker@" = {
      description = "PISS OCaml independently supervised worker for session %i";
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
          cfg.workspace
        ];
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
            "${cfg.package}/bin/pissd-next"
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
            "--public"
            "${cfg.webPackage}/share/piss-next/public"
            "--app-js"
            "${cfg.webPackage}/share/piss-next/public/app.js"
            "--generation"
            (toString cfg.package)
          ]
          ++ lib.concatMap (user: [
            "--allowed-user"
            user
          ]) cfg.allowedUsers
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
