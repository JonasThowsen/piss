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
  serviceStateName = "piss-ocaml";
  runtimeDirectory = "%t/${serviceStateName}";
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
        assertion = cfg.tailscale.authKeyFile == null || lib.hasPrefix "/" cfg.tailscale.authKeyFile;
        message = "services.piss-next.tailscale.authKeyFile must be absolute";
      }
    ];

    environment.systemPackages = [ cfg.package ] ++ lib.optional cfg.tailscale.enable loginTool;

    systemd.user.services.piss-ocaml-worker = {
      description = "PISS OCaml independently supervised session worker";
      wantedBy = [ "default.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      serviceConfig = {
        ExecStart = lib.escapeShellArgs [
          "${cfg.package}/bin/piss-session-worker"
          "--socket"
          "${runtimeDirectory}/worker.sock"
          "--database"
          "%S/${serviceStateName}/worker.sqlite3"
          "--session"
          "deployed-tracer"
          "--worker"
          "deployed-worker"
          "--workspace"
          cfg.workspace
          "--harness"
          "${cfg.package}/bin/piss-mock-agent"
        ];
        Restart = "on-failure";
        RestartSec = 2;
        RuntimeDirectory = serviceStateName;
        RuntimeDirectoryMode = "0700";
        StateDirectory = serviceStateName;
        StateDirectoryMode = "0700";
        UMask = "0077";
        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        ProtectHome = "read-only";
        ProtectSystem = "strict";
        ReadWritePaths = [ "%S/${serviceStateName}" ];
        LockPersonality = true;
        RestrictAddressFamilies = [ "AF_UNIX" ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
      };
    };

    systemd.user.services.piss-ocaml = {
      description = "PISS OCaml replaceable control plane";
      wantedBy = [ "default.target" ];
      after = [ "piss-ocaml-worker.service" ];
      requires = [ "piss-ocaml-worker.service" ];
      serviceConfig = {
        ExecStart = lib.escapeShellArgs [
          "${cfg.package}/bin/pissd-next"
          "--port"
          (toString cfg.port)
          "--worker-socket"
          "${runtimeDirectory}/worker.sock"
          "--public"
          "${cfg.webPackage}/share/piss-next/public"
          "--app-js"
          "${cfg.webPackage}/share/piss-next/public/app.js"
          "--generation"
          (toString cfg.package)
        ];
        Restart = "always";
        RestartSec = 2;
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
