# PISS

[![CI](https://github.com/JonasThowsen/piss/actions/workflows/ci.yml/badge.svg)](https://github.com/JonasThowsen/piss/actions/workflows/ci.yml)

**PISS** — **Pi sin sidecar** — is a private, mobile-first web workspace for [Pi](https://github.com/earendil-works/pi-mono) and OpenCode coding-agent sessions.

The repository contains the production OCaml implementation.

PISS is designed to run on **NixOS + Tailscale**. The flake packages the application; the host configuration owns the service and network policy:

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
web/                OCaml/Bonsai/js_of_ocaml browser application
justfile            canonical development recipes
flake.nix           OCaml 5.5 native shell, OCaml 5.2 web shell, and packages
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

### 2. Use the package

```nix
{ inputs, pkgs, ... }:
{
  environment.systemPackages = [
    inputs.piss.packages.${pkgs.system}.default
  ];
}
```

The package contains `pissd`, `piss-session-worker`, `piss-session-mcp`, and `piss-mock-agent`. Browser assets are under `share/piss/public`; a host service can use `${piss}/share/piss/public` for `--public` and `${piss}/share/piss/public/app.js` for `--app-js`.

Pi, OpenCode, Tailscale, secrets, trusted workspaces, and systemd lifecycle policy deliberately remain host concerns. This keeps the project flake focused on building PISS rather than becoming a second NixOS configuration framework.

## Updating

```bash
cd ~/nixos
nix flake update piss
sudo nixos-rebuild switch --flake .#your-host
```

The host configuration decides when to restart the control plane and how to replace idle workers. PISS keeps worker state durable so replacing the control plane does not duplicate commands.

The browser is installable as a PWA. The fixed shell assets are served with `Cache-Control: no-store`, and the service worker does not cache frontend files. A normal reload therefore uses the deployed generation; the cutover worker also removes shell caches created by releases predating the OCaml implementation.

## Development

```bash
git clone https://github.com/JonasThowsen/piss
cd piss
nix develop                # OCaml 5.5 server shell
just build                 # native OCaml 5.5 and Bonsai OCaml 5.2 builds
just serve                 # run the control plane locally with sensible defaults
just worker                # run a single session worker pointed at the mock agent
```

`just serve` binds the control plane to loopback and enables the local identity bypass (`--dev-bypass-auth`). Production refuses that bypass.

The default shell also provides Nix-pinned Playwright and Chromium for browser integration tests. Browser compilation runs in the separate `.#web` shell because the current Bonsai package set uses OCaml 5.2.

Common recipes:

| Recipe | What it does |
| --- | --- |
| `just build` | Build the native artifacts and Bonsai bundle |
| `just build-native` | Build only the native executables |
| `just build-web` | Build only the browser bundle |
| `just test` | Run the Alcotest unit suite |
| `just test-integration` | Run the shell-driven integration tests |
| `just format` | Auto-format every compiled OCaml source |
| `just format-check` | Verify formatting without modifying files |
| `just check` | format-check + build + test + test-integration |
| `just serve` | Run the control plane against the mock harness |
| `just worker` | Run one session worker against the mock harness |
| `just mock-agent` | Run the deterministic mock ACP agent |
| `just doc` | Build the API documentation |
| `just info` | Print the compiler and build-tool versions |

Run `just` with no arguments to list every recipe.

Browser changes should follow the [web performance guidelines](./docs/WEB-PERFORMANCE.md), especially the Bonsai invalidation-boundary and regression-test checklist.

## Security

See [SECURITY.md](./SECURITY.md) for the supported deployment boundary and vulnerability reporting.

## License

[MIT](./LICENSE)
