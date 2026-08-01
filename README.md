# PISS

[![CI](https://github.com/JonasThowsen/piss/actions/workflows/ci.yml/badge.svg)](https://github.com/JonasThowsen/piss/actions/workflows/ci.yml)

**PISS** — **Pi sin sidecar** — is a private, mobile-first web workspace for [Pi](https://github.com/earendil-works/pi-mono) coding-agent sessions.

PISS owns and supervises Pi RPC runtimes. From a phone or laptop you can create trusted workspaces, run multiple sessions, inspect native messages and tool events, send prompts, steer or queue work, review changes, and install the interface as a PWA.

PISS is designed for **NixOS + Tailscale**. Its NixOS module runs the application behind an independent userspace Tailscale node:

```text
https://piss.<tailnet>.ts.net
```

> [!WARNING]
> Remote Pi control is equivalent to remote access to your user account. Never expose PISS with Tailscale Funnel or an unauthenticated public proxy.

## Features

- Browser-created trusted workspaces and multiple supervised Pi sessions
- Durable session metadata and validated resume from Pi JSONL transcripts
- Native conversation and tool-event timelines
- Prompt, steer, follow-up, abort, archive, and resume controls
- Guided engineering workflows with Define and Plan approvals plus bounded Build, Verify, Review, and repair phases
- Runtime-generation and command-ID protection against stale or duplicate delivery
- Model, thinking-level, context, usage, queue, and compaction controls
- Interactive Pi extension requests (`select`, `confirm`, `input`, and `editor`)
- Workspace-scoped file mentions and read-only Git review in a Bubblewrap sandbox
- PNG, JPEG, GIF, and WebP attachments with signature and size validation
- Per-session browser drafts and an update-safe offline application shell
- Opt-in privacy-safe Web Push notifications
- Mobile navigation, keyboard shortcuts, and global session picking
- Tailscale identity authentication with a secure-by-default allowlist
- Reproducible Nix packages, NixOS module, development shell, and browser tests

See [the architecture](./docs/ARCHITECTURE.md) and [tracer roadmap](./docs/ROADMAP.md) for implementation details and known limitations.

## Requirements

- NixOS with flakes enabled
- Pi installed for the desktop user
- A Tailscale tailnet with MagicDNS and HTTPS certificates enabled
- Node.js only for development; the Nix package supplies its runtime

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
    piCommand = "/home/you/.npm-global/bin/pi";
    workspaceDiscoveryRoots = [ "/home/you/coding" ];
    tailscale.hostname = "piss";
  };
}
```

`allowedUsers` is required by default. To deliberately rely only on tailnet policy, set `allowAllTailnetUsers = true`.

PISS starts without seeded workspaces. Use **+** in the workspace navigation to select or create a directory below `workspaceDiscoveryRoots`. You can also seed trusted roots declaratively:

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

Apply the configuration:

```bash
sudo nixos-rebuild switch --flake ~/nixos#your-host
```

### 3. Authenticate the dedicated Tailscale node

```bash
piss-tailscale-login
```

Open the displayed login URL. Authentication state persists under `~/.local/state/piss/tailscale`.

For unattended enrollment, use a secret file readable by the desktop user:

```nix
services.piss.tailscale.authKeyFile = "/run/secrets/piss-tailscale-auth-key";
```

### 4. Install the PWA

Open the HTTPS URL and choose **Install app** or **Add to Home Screen**. The service worker caches only fixed application-shell assets; private API and session data are never cached.

Enable task alerts from the application if desired. Notification payloads contain an opaque session ID and generic attention state, not prompts, output, workspace names, paths, or credentials.

## Updating

```bash
cd ~/nixos
nix flake update piss
sudo nixos-rebuild switch --flake .#your-host
```

Browser assets and the runtime server are separate module packages, so a browser-only update does not restart active runtimes. A server update is staged without restarting PISS. The update activator asks the running generation to wait until working, queued, compacting, interactive, and autonomous workflow phases have settled; it then performs a short restart and automatically resumes the idle runtimes from their Pi transcripts on the new generation. You can deploy while other sessions are working—the old generation keeps serving them until activation is safe.

The first upgrade from a release without this handoff is staged but not activated automatically, because the old process cannot understand the safe-activation signal. Wait until its sessions are idle and restart `piss.service` once; subsequent updates use the quiescent handoff automatically.

A forced `systemctl --user restart piss` still interrupts active work and should otherwise be reserved for emergencies. Exact process continuity across a server update remains future work, but normal declarative deployments no longer replace an in-flight Pi process.

## Operations

```bash
systemctl --user status piss piss-update-activation piss-tailscaled piss-tailscale-serve
journalctl --user -u piss -u piss-update-activation -f
journalctl --user -u piss-tailscale-serve -f
```

PISS state is stored under `~/.local/state/piss`. Pi's own JSONL session files remain the source of truth for conversation history.

## Development

```bash
git clone https://github.com/JonasThowsen/piss
cd piss
nix develop
npm ci
npm run dev
```

`npm run dev` binds both servers to loopback and enables the local identity bypass. Production refuses that bypass.

Common commands:

```bash
npm run check
npm run test:browser
npm run build
npm run audit
nix flake check
nix build .#piss
```

The canonical source layout is:

```text
server/        Effect services, HTTP adapter, and Pi runtime supervision
shared/        Effect schemas and shared state rules
web/           React PWA
browser-test/  Playwright coverage
test/          Node integration and unit tests
nix/           NixOS module
```

## Module options

| Option | Default | Purpose |
| --- | --- | --- |
| `services.piss.enable` | `false` | Enable PISS |
| `services.piss.package` | `piss-server` | Runtime server package |
| `services.piss.webPackage` | `piss-web` | Independently updatable browser shell |
| `services.piss.port` | `4317` | Loopback application port |
| `services.piss.piCommand` | `"pi"` | Pi CLI executable |
| `services.piss.allowedUsers` | `[]` | Explicit Tailscale login allowlist |
| `services.piss.allowAllTailnetUsers` | `false` | Permit every identity allowed by tailnet policy |
| `services.piss.workspaceDiscoveryRoots` | `[]` | Roots available for workspace discovery and creation |
| `services.piss.workspaces` | `[]` | Declaratively trusted workspace roots |
| `services.piss.tailscale.enable` | `true` | Run the independent userspace node |
| `services.piss.tailscale.hostname` | `"piss"` | Dedicated tailnet hostname |
| `services.piss.tailscale.stateName` | `"piss"` | Tailscale state/runtime directory name |
| `services.piss.tailscale.authKeyFile` | `null` | Optional unattended enrollment key file |

## Security

See [SECURITY.md](./SECURITY.md) for the supported deployment boundary and vulnerability reporting.

## License

[MIT](./LICENSE)
