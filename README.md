# PISS

[![CI](https://github.com/JonasThowsen/piss/actions/workflows/ci.yml/badge.svg)](https://github.com/JonasThowsen/piss/actions/workflows/ci.yml)

**PISS** — **Pi sin sidecar** — is a private, mobile-first web workspace for [Pi](https://github.com/earendil-works/pi-mono) and OpenCode coding-agent sessions.

The repository is the OCaml/Melange rewrite. The previous TypeScript/Effect implementation is preserved under `legacy/` for reference only — it is not built or deployed.

PISS is designed for **NixOS + Tailscale**. Its NixOS module runs the application behind an independent userspace Tailscale node:

```text
https://piss.<tailnet>.ts.net
```

> [!WARNING]
> Remote agent control is equivalent to remote access to your user account. Never expose PISS with Tailscale Funnel or an unauthenticated public proxy.

## Source layout

```text
src/                OCaml native services
  lib/              shared library (types, protocols, SQLite stores)
  control/          piss-control (replaceable control plane)
  worker/           piss-session-worker (one per active session)
  session_mcp/      piss-session-mcp (collaboration broker)
  mock_agent/       piss-mock-agent (deterministic ACP fixture)
  test/             unit + shell-driven integration tests
web/                OCaml/Reason/Melange browser shell
nix/                NixOS module and pinned harness packages
legacy/             previous TypeScript implementation (not built)
justfile            canonical development recipes
flake.nix           Nix packages and NixOS module
```

## Install on NixOS

### 1. Add the flake input

```nix
{
  inputs.piss = {
    url = "github:JonasThowsen/piss";
    inputs.nixpkgs.follows = "nixpkgs";
  };
}
```

### 2. Enable the service

```nix
{ inputs, ... }:
{
  imports = [ inputs.piss.nixosModules.default ];

  services.piss = {
    enable = true;
    allowedUsers = [ "you@example.com" ];
    workspaceDiscoveryRoots = [ "/home/you/coding" ];
    tailscale.hostname = "piss-ocaml";
  };
}
```

`allowedUsers` is required by default. To deliberately rely only on tailnet policy, set `allowAllTailnetUsers = true`.

Seed trusted workspaces declaratively:

```nix
services.piss.workspaces = [
  {
    name = "PISS";
    path = "/home/you/coding/piss";
    trustProjectResources = false;
  }
];
```

Set `trustProjectResources = true` only when Pi may load that workspace's local settings, extensions, skills, and packages.

Pi runtimes share your normal SSH agent. PISS automatically uses `SSH_AUTH_SOCK` or the standard `$XDG_RUNTIME_DIR/ssh-agent`, so one `ssh-add` applies to every session. If your agent uses another stable socket (for example 1Password or GCR), configure it explicitly:

```nix
services.piss.sshAgentSocket = "/run/user/1000/gcr/ssh";
```

Apply the configuration:

```bash
sudo nixos-rebuild switch --flake ~/nixos#your-host
```

### 3. Authenticate the dedicated Tailscale node

```bash
piss-tailscale-login
```

Authentication state persists under `~/.local/state/piss`.

For unattended enrollment, use a secret file readable by the desktop user:

```nix
services.piss.tailscale.authKeyFile = "/run/secrets/piss-tailscale-auth-key";
```

### 4. Install the PWA

Open the HTTPS URL and choose **Install app** or **Add to Home Screen**. The service worker caches only fixed application-shell assets; private API and session data are never cached.

## Updating

```bash
cd ~/nixos
nix flake update piss
sudo nixos-rebuild switch --flake .#your-host
```

Browser assets and the runtime server are separate module packages, so a browser-only update does not restart active runtimes. Worker upgrades are session-scoped: an enabled-by-default timer compares each running worker with the current generation and replaces idle workers without disturbing busy ones.

## Operations

```bash
systemctl --user status piss piss-worker-upgrade piss-tailscaled piss-tailscale-serve
journalctl --user -u piss -u piss-worker-upgrade -f
```

PISS state is stored under `~/.local/state/piss`.

## Development

```bash
git clone https://github.com/JonasThowsen/piss
cd piss
nix develop                # exposes opam, dune, node, system tools
just switch                # one-time: create the OCaml 5.5 opam switch
just build                 # dune build @all @web-bundle
just serve                 # run the control plane locally with sensible defaults
just worker                # run a single session worker pointed at the mock agent
```

`just serve` binds the control plane to loopback and enables the local identity bypass (`--dev-bypass-auth`). Production refuses that bypass.

Common recipes:

| Recipe | What it does |
| --- | --- |
| `just build` | Build every OCaml artifact and the Melange bundle |
| `just build-native` | Build only the native executables |
| `just build-web` | Build only the browser bundle |
| `just test` | Run the Alcotest unit suite |
| `just test-integration` | Run the shell-driven integration tests |
| `just format` | Auto-format every OCaml and Reason source |
| `just format-check` | Verify formatting without modifying files |
| `just check` | format-check + build + test + test-integration |
| `just serve` | Run the control plane against the mock harness |
| `just worker` | Run one session worker against the mock harness |
| `just mock-agent` | Run the deterministic mock ACP agent |
| `just doc` | Build the API documentation |
| `just info` | Print the active opam switch and tool versions |

Run `just` with no arguments to list every recipe.

## Module options

| Option | Default | Purpose |
| --- | --- | --- |
| `services.piss.enable` | `false` | Enable PISS |
| `services.piss.controlPackage` | `piss-control` | Replaceable control-plane package |
| `services.piss.workerPackage` | `piss-session-worker` | Stable session-worker package |
| `services.piss.sessionMcpPackage` | `piss-session-mcp` | Inter-session collaboration server |
| `services.piss.mockAgentPackage` | `piss-mock-agent` | Deterministic ACP fixture |
| `services.piss.adapterPackage` | `pi-acp` | Pinned Pi ACP adapter |
| `services.piss.opencodePackage` | `opencode` | Pinned OpenCode binary |
| `services.piss.webPackage` | `piss-web` | Independently updatable browser shell |
| `services.piss.port` | `4318` | Loopback application port |
| `services.piss.sshAgentSocket` | auto-detected | Shared SSH agent socket inherited by every worker |
| `services.piss.allowedUsers` | `[]` | Explicit Tailscale login allowlist |
| `services.piss.allowAllTailnetUsers` | `false` | Permit every identity allowed by tailnet policy |
| `services.piss.workspaceDiscoveryRoots` | `[]` | Roots available for workspace discovery and creation |
| `services.piss.workspaces` | `[]` | Declaratively trusted workspace roots |
| `services.piss.autoUpgradeIdleWorkers` | `true` | Compare and upgrade idle workers against the current generation |
| `services.piss.workerUpgradeInterval` | `"1min"` | How often the upgrade timer runs |
| `services.piss.tailscale.enable` | `true` | Run the independent userspace node |
| `services.piss.tailscale.hostname` | `"piss-ocaml"` | Dedicated tailnet hostname |
| `services.piss.tailscale.authKeyFile` | `null` | Optional unattended enrollment key file |

## Security

See [SECURITY.md](./SECURITY.md) for the supported deployment boundary and vulnerability reporting.

## License

[MIT](./LICENSE)
