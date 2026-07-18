self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.piss;
  defaultPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
  socket = "%t/piss/tailscaled.sock";

  tailscaledRunner = pkgs.writeShellScript "piss-tailscaled" ''
    set -euo pipefail
    state="$HOME/.local/state/piss/tailscale"
    mkdir -p "$state"
    exec ${lib.getExe' pkgs.tailscale "tailscaled"} \
      --tun=userspace-networking \
      --port=0 \
      --statedir="$state" \
      --socket="$XDG_RUNTIME_DIR/piss/tailscaled.sock"
  '';

  tailscaleUp = pkgs.writeShellScript "piss-tailscale-up" ''
    set -euo pipefail
    socket="$XDG_RUNTIME_DIR/piss/tailscaled.sock"
    state="$(${lib.getExe pkgs.tailscale} --socket="$socket" status --json 2>/dev/null | ${lib.getExe pkgs.jq} -r '.BackendState // ""' || true)"
    if [[ "$state" == "Running" ]]; then
      exit 0
    fi
    ${
      if cfg.tailscale.authKeyFile != null then
        ''
          exec ${lib.getExe pkgs.tailscale} --socket="$socket" up \
            --reset \
            --accept-dns=false \
            --hostname=${lib.escapeShellArg cfg.tailscale.hostname} \
            --auth-key=file:${lib.escapeShellArg cfg.tailscale.authKeyFile} \
            --timeout=30s
        ''
      else
        ''
          echo "PISS has not joined the tailnet yet." >&2
          echo "Run: piss-tailscale-login" >&2
          exit 1
        ''
    }
  '';

  tailscaleServe = pkgs.writeShellScript "piss-tailscale-serve" ''
    set -euo pipefail
    socket="$XDG_RUNTIME_DIR/piss/tailscaled.sock"
    for _ in $(seq 1 60); do
      state="$(${lib.getExe pkgs.tailscale} --socket="$socket" status --json 2>/dev/null | ${lib.getExe pkgs.jq} -r '.BackendState // ""' || true)"
      [[ "$state" == "Running" ]] && break
      sleep 1
    done
    [[ "$state" == "Running" ]] || { echo "PISS Tailscale node is not authenticated; run piss-tailscale-login" >&2; exit 1; }
    exec ${lib.getExe pkgs.tailscale} --socket="$socket" serve --bg --yes \
      http://127.0.0.1:${toString cfg.port}
  '';

  loginTool = pkgs.writeShellScriptBin "piss-tailscale-login" ''
    set -euo pipefail
    socket="''${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/piss/tailscaled.sock"
    ${lib.getExe pkgs.tailscale} --socket="$socket" up \
      --reset \
      --accept-dns=false \
      --hostname=${lib.escapeShellArg cfg.tailscale.hostname}
    systemctl --user restart piss-tailscale-serve.service
  '';
in
{
  options.services.piss = {
    enable = lib.mkEnableOption "PISS, Pi sin sidecar";

    package = lib.mkOption {
      type = lib.types.package;
      default = defaultPackage;
      defaultText = lib.literalExpression "inputs.piss.packages.\${system}.default";
      description = "PISS package to run and expose as a Pi package.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 4317;
      description = "Loopback port for the PISS web and bridge server.";
    };

    allowedUsers = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "you@example.com" ];
      description = "Tailscale user logins allowed in the browser. Empty permits users allowed by tailnet policy.";
    };

    tailscale = {
      enable = lib.mkEnableOption "a separate userspace Tailscale node for PISS" // {
        default = true;
      };

      hostname = lib.mkOption {
        type = lib.types.str;
        default = "piss";
        description = "Hostname for the independent Tailscale node, producing piss.<tailnet>.ts.net by default.";
      };

      authKeyFile = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "/run/secrets/piss-tailscale-auth-key";
        description = "Optional file containing a Tailscale auth key. Without it, authenticate once with piss-tailscale-login.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ] ++ lib.optional cfg.tailscale.enable loginTool;

    systemd.user.services.piss = {
      description = "PISS — Pi sin sidecar";
      wantedBy = [ "default.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      conflicts = [ "pi-sidecar.service" ];
      environment = {
        NODE_ENV = "production";
        PISS_HOST = "127.0.0.1";
        PISS_PORT = toString cfg.port;
        PISS_ALLOWED_USERS = lib.concatStringsSep "," cfg.allowedUsers;
      };
      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        Restart = "on-failure";
        RestartSec = 2;
        NoNewPrivileges = true;
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
        RuntimeDirectory = "piss";
        RuntimeDirectoryMode = "0700";
        NoNewPrivileges = true;
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
