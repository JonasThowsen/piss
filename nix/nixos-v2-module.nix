self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.piss-v2;
  defaultPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.piss-v2-server;
  defaultWebPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.piss-v2-web;
  serviceStateName = "piss-v2";
  tailscaleStateName = cfg.tailscale.stateName;
  socket = "$XDG_RUNTIME_DIR/${tailscaleStateName}/tailscaled.sock";

  tailscaledRunner = pkgs.writeShellScript "piss-v2-tailscaled" ''
    set -euo pipefail
    state="$HOME/.local/state/${tailscaleStateName}/tailscale"
    mkdir -p "$state"
    exec ${lib.getExe' pkgs.tailscale "tailscaled"} \
      --tun=userspace-networking \
      --port=0 \
      --statedir="$state" \
      --socket="${socket}"
  '';

  tailscaleUp = pkgs.writeShellScript "piss-v2-tailscale-up" ''
    set -euo pipefail
    state="$(${lib.getExe pkgs.tailscale} --socket="${socket}" status --json 2>/dev/null | ${lib.getExe pkgs.jq} -r '.BackendState // ""' || true)"
    if [[ "$state" == "Running" ]]; then
      exit 0
    fi
    ${
      if cfg.tailscale.authKeyFile != null then
        ''
          exec ${lib.getExe pkgs.tailscale} --socket="${socket}" up \
            --reset \
            --accept-dns=false \
            --hostname=${lib.escapeShellArg cfg.tailscale.hostname} \
            --auth-key=file:${lib.escapeShellArg cfg.tailscale.authKeyFile} \
            --timeout=30s
        ''
      else
        ''
          echo "PISS V2 has not joined the tailnet yet; run piss-v2-tailscale-login." >&2
          exit 0
        ''
    }
  '';

  tailscaleServe = pkgs.writeShellScript "piss-v2-tailscale-serve" ''
    set -euo pipefail
    for _ in $(seq 1 60); do
      state="$(${lib.getExe pkgs.tailscale} --socket="${socket}" status --json 2>/dev/null | ${lib.getExe pkgs.jq} -r '.BackendState // ""' || true)"
      [[ "$state" == "Running" ]] && break
      sleep 1
    done
    [[ "$state" == "Running" ]] || { echo "PISS V2 Tailscale node is not authenticated; run piss-v2-tailscale-login" >&2; exit 1; }
    exec ${lib.getExe pkgs.tailscale} --socket="${socket}" serve --bg --yes \
      http://127.0.0.1:${toString cfg.port}
  '';

  loginTool = pkgs.writeShellScriptBin "piss-v2-tailscale-login" ''
    set -euo pipefail
    socket="''${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/${tailscaleStateName}/tailscaled.sock"
    ${lib.getExe pkgs.tailscale} --socket="$socket" up \
      --reset \
      --accept-dns=false \
      --hostname=${lib.escapeShellArg cfg.tailscale.hostname}
    systemctl --user restart piss-v2-tailscale-up.service piss-v2-tailscale-serve.service
  '';
in
{
  options.services.piss-v2 = {
    enable = lib.mkEnableOption "the Effect-based PISS V2 control plane";

    package = lib.mkOption {
      type = lib.types.package;
      default = defaultPackage;
      defaultText = lib.literalExpression "inputs.piss.packages.\${system}.piss-v2-server";
      description = "PISS V2 runtime server package.";
    };

    webPackage = lib.mkOption {
      type = lib.types.package;
      default = defaultWebPackage;
      defaultText = lib.literalExpression "inputs.piss.packages.\${system}.piss-v2-web";
      description = "PISS V2 browser-shell package. Updating only this package does not restart active runtimes.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 4318;
      description = "Loopback port for PISS V2.";
    };

    piCommand = lib.mkOption {
      type = lib.types.str;
      default = "pi";
      example = "/home/you/.npm-global/bin/pi";
      description = "Absolute Pi CLI path recommended for the systemd user service.";
    };

    allowedUsers = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "you@example.com" ];
      description = "Tailscale user logins allowed in V2. Required unless allowAllTailnetUsers is enabled.";
    };

    allowAllTailnetUsers = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Allow every identity permitted by tailnet policy. Prefer allowedUsers.";
    };

    workspaceDiscoveryRoots = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "/home/me/coding" ];
      description = "Absolute roots within which V2 may fuzzy-search directories and create durable workspaces.";
    };

    workspaces = lib.mkOption {
      default = [ ];
      description = "Trusted workspace roots shown by V2 and available to owned Pi runtimes.";
      type = lib.types.listOf (
        lib.types.submodule {
          options = {
            name = lib.mkOption {
              type = lib.types.str;
              description = "Human-readable workspace name.";
            };
            path = lib.mkOption {
              type = lib.types.str;
              description = "Absolute trusted workspace root.";
            };
            trustProjectResources = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = "Allow Pi RPC sessions to load project-local settings, extensions, skills, and packages.";
            };
          };
        }
      );
      example = [
        {
          name = "PISS";
          path = "/home/me/coding/piss";
        }
      ];
    };

    tailscale = {
      enable = lib.mkEnableOption "an independent userspace Tailscale node for PISS V2" // {
        default = true;
      };

      hostname = lib.mkOption {
        type = lib.types.str;
        default = "piss-v2";
        description = "Hostname for the independent V2 Tailscale node.";
      };

      stateName = lib.mkOption {
        type = lib.types.strMatching "[a-zA-Z0-9_-]+";
        default = "piss-v2";
        description = "State/runtime directory name for the V2 Tailscale node; set this to a retired service's name to adopt its existing tailnet identity.";
      };

      authKeyFile = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "/run/secrets/piss-v2-tailscale-auth-key";
        description = "Optional file containing a Tailscale auth key.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.allowedUsers != [ ] || cfg.allowAllTailnetUsers;
        message = "services.piss-v2.allowedUsers must contain at least one Tailscale login unless allowAllTailnetUsers = true";
      }
      {
        assertion = lib.all (workspace: lib.hasPrefix "/" workspace.path) cfg.workspaces;
        message = "Every services.piss-v2.workspaces path must be absolute";
      }
      {
        assertion = lib.all (root: lib.hasPrefix "/" root) cfg.workspaceDiscoveryRoots;
        message = "Every services.piss-v2.workspaceDiscoveryRoots entry must be absolute";
      }
    ];

    environment.systemPackages = [ cfg.package ] ++ lib.optional cfg.tailscale.enable loginTool;
    environment.etc."piss-v2/public".source = "${cfg.webPackage}/share/piss-v2/public";

    systemd.user.services.piss-v2 = {
      description = "PISS V2 — Effect control plane";
      path = [ pkgs.nodejs_24 pkgs.bashInteractive pkgs.nix ];
      wantedBy = [ "default.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      environment = {
        NODE_ENV = "production";
        PISS_V2_HOST = "127.0.0.1";
        PISS_V2_PORT = toString cfg.port;
        PISS_V2_PI_COMMAND = cfg.piCommand;
        # This stable profile path changes atomically on activation without
        # changing the service unit or restarting its owned Pi runtimes.
        PISS_V2_PUBLIC_DIR = "/etc/piss-v2/public";
        PISS_V2_ALLOWED_USERS = lib.concatStringsSep "," cfg.allowedUsers;
        PISS_V2_WORKSPACE_DISCOVERY_ROOTS = builtins.toJSON cfg.workspaceDiscoveryRoots;
        PISS_V2_WORKSPACES = builtins.toJSON (
          map (workspace: {
            inherit (workspace) name;
            root = workspace.path;
            inherit (workspace) trustProjectResources;
          }) cfg.workspaces
        );
      };
      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        Restart = "on-failure";
        RestartSec = 2;
        StateDirectory = serviceStateName;
        StateDirectoryMode = "0700";
        UMask = "0077";
        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        ProtectHome = "read-only";
        ProtectSystem = "strict";
        ReadWritePaths = [
          "%S/${serviceStateName}"
          "-%h/.pi/agent"
        ]
        ++ map (workspace: workspace.path) cfg.workspaces
        ++ cfg.workspaceDiscoveryRoots;
        ProtectClock = true;
        ProtectControlGroups = true;
        ProtectKernelLogs = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_NETLINK"
          "AF_UNIX"
        ];
        # Workspace reviews create short-lived bubblewrap user/mount/PID/network
        # namespaces. The sandbox itself drops capabilities and exposes only
        # read-only checkout and Nix store mounts.
        RestrictNamespaces = false;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
      };
    };

    systemd.user.services.piss-v2-tailscaled = lib.mkIf cfg.tailscale.enable {
      description = "Independent userspace Tailscale node for PISS V2";
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
        ProtectClock = true;
        ProtectControlGroups = true;
        ProtectKernelLogs = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_NETLINK"
          "AF_UNIX"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
      };
    };

    systemd.user.services.piss-v2-tailscale-up = lib.mkIf cfg.tailscale.enable {
      description = "Authenticate the independent PISS V2 Tailscale node";
      wantedBy = [ "default.target" ];
      after = [ "piss-v2-tailscaled.service" ];
      requires = [ "piss-v2-tailscaled.service" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = tailscaleUp;
        RemainAfterExit = true;
      };
    };

    systemd.user.services.piss-v2-tailscale-serve = lib.mkIf cfg.tailscale.enable {
      description = "Serve PISS V2 at ${cfg.tailscale.hostname}.<tailnet>.ts.net";
      wantedBy = [ "default.target" ];
      after = [
        "piss-v2.service"
        "piss-v2-tailscaled.service"
        "piss-v2-tailscale-up.service"
      ];
      requires = [
        "piss-v2.service"
        "piss-v2-tailscaled.service"
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
