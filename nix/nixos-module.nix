self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.piss;
  defaultPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.piss-server;
  defaultWebPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.piss-web;
  serviceStateName = "piss";
  tailscaleStateName = cfg.tailscale.stateName;
  socket = "$XDG_RUNTIME_DIR/${tailscaleStateName}/tailscaled.sock";
  deploymentGeneration = builtins.hashString "sha256" (
    builtins.toJSON {
      package = toString cfg.package;
      module = builtins.hashFile "sha256" ./nixos-module.nix;
      inherit (cfg)
        port
        piCommand
        allowedUsers
        workspaceDiscoveryRoots
        workspaces
        ;
      runtimePackages = map toString [
        pkgs.nodejs_24
        pkgs.bashInteractive
        pkgs.nix
      ];
    }
  );

  activateUpdate = pkgs.writeShellScript "piss-activate-update" ''
    set -euo pipefail
    systemctl=${lib.getExe' pkgs.systemd "systemctl"}
    pid="$($systemctl --user show --property=MainPID --value piss.service)"
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || exit 0

    current=""
    current_port=""
    while IFS= read -r entry; do
      if [[ "$entry" == PISS_DEPLOYMENT_GENERATION=* ]]; then
        current="''${entry#PISS_DEPLOYMENT_GENERATION=}"
      elif [[ "$entry" == PISS_PORT=* ]]; then
        current_port="''${entry#PISS_PORT=}"
      fi
    done < <(${lib.getExe' pkgs.coreutils "tr"} '\0' '\n' < "/proc/$pid/environ")

    [[ "$current" == ${lib.escapeShellArg deploymentGeneration} ]] && exit 0
    [[ "$current_port" =~ ^[1-9][0-9]*$ ]] || current_port=${toString cfg.port}

    health="$(${lib.getExe pkgs.curl} --silent --fail --max-time 2 \
      "http://127.0.0.1:$current_port/api/health" || true)"
    if [[ "$health" != *'"updateActivation":"quiescent-sigusr2"'* ]]; then
      echo "PISS update staged, but the running generation predates safe activation." >&2
      echo "Restart piss.service once when its sessions are idle; later updates will activate automatically." >&2
      exit 0
    fi

    echo "Staged PISS update differs from running generation; activation will wait for active work to settle"
    $systemctl --user kill --kill-whom=main --signal=SIGUSR2 piss.service
  '';

  tailscaledRunner = pkgs.writeShellScript "piss-tailscaled" ''
    set -euo pipefail
    state="$HOME/.local/state/${tailscaleStateName}/tailscale"
    mkdir -p "$state"
    exec ${lib.getExe' pkgs.tailscale "tailscaled"} \
      --tun=userspace-networking \
      --port=0 \
      --statedir="$state" \
      --socket="${socket}"
  '';

  tailscaleUp = pkgs.writeShellScript "piss-tailscale-up" ''
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
          echo "PISS has not joined the tailnet yet; run piss-tailscale-login." >&2
          exit 0
        ''
    }
  '';

  tailscaleServe = pkgs.writeShellScript "piss-tailscale-serve" ''
    set -euo pipefail
    for _ in $(seq 1 60); do
      state="$(${lib.getExe pkgs.tailscale} --socket="${socket}" status --json 2>/dev/null | ${lib.getExe pkgs.jq} -r '.BackendState // ""' || true)"
      [[ "$state" == "Running" ]] && break
      sleep 1
    done
    [[ "$state" == "Running" ]] || { echo "PISS Tailscale node is not authenticated; run piss-tailscale-login" >&2; exit 1; }
    exec ${lib.getExe pkgs.tailscale} --socket="${socket}" serve --bg --yes \
      http://127.0.0.1:${toString cfg.port}
  '';

  loginTool = pkgs.writeShellScriptBin "piss-tailscale-login" ''
    set -euo pipefail
    socket="''${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/${tailscaleStateName}/tailscaled.sock"
    ${lib.getExe pkgs.tailscale} --socket="$socket" up \
      --reset \
      --accept-dns=false \
      --hostname=${lib.escapeShellArg cfg.tailscale.hostname}
    systemctl --user restart piss-tailscale-up.service piss-tailscale-serve.service
  '';
in
{
  options.services.piss = {
    enable = lib.mkEnableOption "the Effect-based PISS control plane";

    package = lib.mkOption {
      type = lib.types.package;
      default = defaultPackage;
      defaultText = lib.literalExpression "inputs.piss.packages.\${system}.piss-server";
      description = "PISS runtime server package.";
    };

    webPackage = lib.mkOption {
      type = lib.types.package;
      default = defaultWebPackage;
      defaultText = lib.literalExpression "inputs.piss.packages.\${system}.piss-web";
      description = "PISS browser-shell package. Updating only this package does not restart active runtimes.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 4317;
      description = "Loopback port for PISS.";
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
      description = "Tailscale user logins allowed in PISS. Required unless allowAllTailnetUsers is enabled.";
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
      description = "Absolute roots within which PISS may fuzzy-search directories and create durable workspaces.";
    };

    workspaces = lib.mkOption {
      default = [ ];
      description = "Trusted workspace roots shown by PISS and available to owned Pi runtimes.";
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
      enable = lib.mkEnableOption "an independent userspace Tailscale node for PISS" // {
        default = true;
      };

      hostname = lib.mkOption {
        type = lib.types.str;
        default = "piss";
        description = "Hostname for the independent Tailscale node.";
      };

      stateName = lib.mkOption {
        type = lib.types.strMatching "[a-zA-Z0-9_-]+";
        default = "piss";
        description = "State/runtime directory name for the Tailscale node; set this to a retired service's name to adopt its existing tailnet identity.";
      };

      authKeyFile = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "/run/secrets/piss-tailscale-auth-key";
        description = "Optional file containing a Tailscale auth key.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.allowedUsers != [ ] || cfg.allowAllTailnetUsers;
        message = "services.piss.allowedUsers must contain at least one Tailscale login unless allowAllTailnetUsers = true";
      }
      {
        assertion = lib.all (workspace: lib.hasPrefix "/" workspace.path) cfg.workspaces;
        message = "Every services.piss.workspaces path must be absolute";
      }
      {
        assertion = lib.all (root: lib.hasPrefix "/" root) cfg.workspaceDiscoveryRoots;
        message = "Every services.piss.workspaceDiscoveryRoots entry must be absolute";
      }
    ];

    environment.systemPackages = [ cfg.package ] ++ lib.optional cfg.tailscale.enable loginTool;
    environment.etc."piss/public".source = "${cfg.webPackage}/share/piss/public";

    systemd.user.services.piss = {
      description = "PISS — Effect control plane";
      # A switch stages the new unit without replacing the process that owns Pi
      # runtimes. piss-update-activation asks that process to exit only after
      # working, compacting, queued, and interactive sessions have settled.
      restartIfChanged = false;
      notSocketActivated = true;
      path = [
        pkgs.nodejs_24
        pkgs.bashInteractive
        pkgs.nix
      ];
      wantedBy = [ "default.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      environment = {
        NODE_ENV = "production";
        PISS_DEPLOYMENT_GENERATION = deploymentGeneration;
        PISS_HOST = "127.0.0.1";
        PISS_PORT = toString cfg.port;
        PISS_PI_COMMAND = cfg.piCommand;
        # This stable profile path changes atomically on activation without
        # changing the service unit or restarting its owned Pi runtimes.
        PISS_PUBLIC_DIR = "/etc/piss/public";
        PISS_ALLOWED_USERS = lib.concatStringsSep "," cfg.allowedUsers;
        PISS_WORKSPACE_DISCOVERY_ROOTS = builtins.toJSON cfg.workspaceDiscoveryRoots;
        PISS_WORKSPACES = builtins.toJSON (
          map (workspace: {
            inherit (workspace) name;
            root = workspace.path;
            inherit (workspace) trustProjectResources;
          }) cfg.workspaces
        );
      };
      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        # A quiescent update exits cleanly after SIGUSR2; always restart so the
        # user manager launches the newly staged ExecStart generation.
        Restart = "always";
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

    systemd.user.services.piss-update-activation = {
      description = "Activate staged PISS update after sessions settle";
      wantedBy = [ "default.target" ];
      after = [ "piss.service" ];
      requires = [ "piss.service" ];
      stopIfChanged = false;
      serviceConfig = {
        Type = "oneshot";
        ExecStart = activateUpdate;
        RemainAfterExit = true;
      };
    };

    systemd.user.services.piss-tailscaled = lib.mkIf cfg.tailscale.enable {
      description = "Independent userspace Tailscale node for PISS";
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

    systemd.user.services.piss-tailscale-up = lib.mkIf cfg.tailscale.enable {
      description = "Authenticate the independent PISS Tailscale node";
      wantedBy = [ "default.target" ];
      after = [ "piss-tailscaled.service" ];
      requires = [ "piss-tailscaled.service" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = tailscaleUp;
        RemainAfterExit = true;
      };
    };

    systemd.user.services.piss-tailscale-serve = lib.mkIf cfg.tailscale.enable {
      description = "Serve PISS at ${cfg.tailscale.hostname}.<tailnet>.ts.net";
      wantedBy = [ "default.target" ];
      after = [
        "piss.service"
        "piss-tailscaled.service"
        "piss-tailscale-up.service"
      ];
      requires = [
        "piss.service"
        "piss-tailscaled.service"
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
