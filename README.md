# PISS

[![CI](https://github.com/JonasThowsen/piss/actions/workflows/ci.yml/badge.svg)](https://github.com/JonasThowsen/piss/actions/workflows/ci.yml)

**PISS** — **Pi sin sidecar** — is a private, mobile-first web interface for live [Pi](https://github.com/earendil-works/pi-mono) coding-agent sessions.

It streams Pi's native messages and tool events instead of mirroring a terminal. From a phone or laptop you can inspect multiple sessions, send prompts, steer between tool calls, queue follow-ups, abort work, paste or upload images, and install the interface as a PWA.

PISS is intentionally designed for **NixOS + Tailscale**. The NixOS module runs the application and an independent userspace Tailscale node, giving it a dedicated URL without consuming the host's normal Tailscale Serve configuration:

```text
https://piss.<tailnet>.ts.net
```

> [!WARNING]
> Remote Pi control is equivalent to remote access to your user account. PISS is a privileged administration interface. Never expose it with Tailscale Funnel or an unauthenticated public proxy.

## Features

- Native Pi message and tool-event streaming
- Prompt, steer, follow-up, and abort controls
- Phone image upload and desktop clipboard screenshots
- Per-session persistent drafts
- Controlled follow-to-bottom scrolling
- Mobile session drawer and installable PWA
- Immediate archiving of stale offline session cards
- Read-only staged, unstaged, and untracked Git review with bounded unified diffs
- Tailscale identity authentication with a secure-by-default allowlist
- Independent Tailscale hostname and HTTPS certificate
- Runtime-generation protection against stale commands
- Runtime protocol validation, payload limits, backpressure, and image signature checks
- Reproducible Nix package, NixOS module, and development shell
- Type checking with the TypeScript 7 native Go compiler (`tsgo`)

## Requirements

- NixOS with flakes enabled
- Pi installed for the desktop user
- A Tailscale tailnet with MagicDNS and HTTPS certificates enabled
- Node.js is only required for development; the Nix package supplies its runtime

## Install on NixOS

### 1. Add the flake input

In your NixOS `flake.nix`:

```nix
{
  inputs.piss = {
    url = "github:JonasThowsen/piss";
    inputs.nixpkgs.follows = "nixpkgs";
  };
}
```

### 2. Enable the service

Import the module and allow your Tailscale login:

```nix
{ inputs, ... }:
{
  imports = [ inputs.piss.nixosModules.default ];

  services.piss = {
    enable = true;
    allowedUsers = [ "you@example.com" ];
    tailscale.hostname = "piss";
  };
}
```

`allowedUsers` is required by default. To deliberately rely only on tailnet policy, set `allowAllTailnetUsers = true`.

Apply the configuration:

```bash
sudo nixos-rebuild switch --flake ~/nixos#your-host
```

### 3. Authenticate the dedicated Tailscale node

On first installation:

```bash
piss-tailscale-login
```

Open the displayed login URL. PISS then becomes available at:

```text
https://piss.<tailnet>.ts.net
```

The login persists under `~/.local/state/piss/tailscale`. If the hostname already exists, remove or rename the stale node in the Tailscale admin console.

For unattended enrollment, use a secret file readable by the desktop user:

```nix
services.piss.tailscale.authKeyFile = "/run/secrets/piss-tailscale-auth-key";
```

### 4. Install the Pi bridge

Once this repository is public:

```bash
pi install git:github.com/JonasThowsen/piss
```

For a local checkout instead:

```bash
pi install /path/to/piss
```

Start a new Pi process, or run `/reload` in an existing one. The bridge connects over loopback using the mode-0600 credential at `~/.local/state/piss/bridge-token`.

### 5. Install the PWA

Open the HTTPS URL on your phone and choose **Install app** or **Add to Home Screen**. The service worker caches only the application shell; session data still requires a live authenticated connection.

## Updating

Update the Nix input and switch generations:

```bash
cd ~/nixos
nix flake update piss
sudo nixos-rebuild switch --flake .#your-host
```

Update a Pi Git package with:

```bash
pi update --extensions
```

## Operations

```bash
systemctl --user status piss piss-tailscaled piss-tailscale-serve
journalctl --user -u piss -f
journalctl --user -u piss-tailscale-serve -f
```

Only offline sessions can be archived from the session list. Archiving dismisses the cached card; if that Pi runtime reconnects, it appears again automatically.

Use **Review changes** at the bottom of a live session to inspect staged, unstaged, and untracked files. Git commands are fixed and read-only, execute in that session's working directory through its authenticated bridge, and enforce file-count, file-size, patch-size, and total-buffer limits.

## Development

```bash
git clone https://github.com/JonasThowsen/piss
cd piss
nix develop
npm ci
```

The dev shell adds `node_modules/.bin` to `PATH`, so both TypeScript commands are directly available after `npm ci`:

```bash
tsgo --version   # TypeScript 7 native Go implementation used by CI
# Compatibility compiler, also installed as a dev dependency:
tsc --version
```

Common commands:

```bash
npm run dev
npm run typecheck
npm run typecheck:tsc
npm test
npm run build
npm run audit
nix flake check
nix build .#piss
```

`npm run dev` enables authentication bypass only for its loopback development server. Production refuses that setting.

### Hot reload through the dedicated tailnet URL

When the NixOS service is already installed and running, develop against the same URL used by the phone without rebuilding NixOS:

```bash
npm run dev:tailnet
```

This command:

1. reads the hostname, port, and browser allowlist from the installed `piss.service`;
2. stops the immutable application service while leaving its dedicated Tailscale node running;
3. points Tailscale Serve at the local Vite server;
4. starts the backend with `tsx watch` and the frontend with Vite HMR; and
5. restores the production service and Serve target when you press Ctrl-C.

Open the existing `https://piss.<tailnet>.ts.net` URL on the phone. The development client removes the production service worker and reloads once so it cannot hide Vite updates. React and CSS edits then update in place; server edits restart the backend and the Pi bridge reconnects automatically. Browser/API access remains protected by the Tailscale identity header and inherits `PISS_ALLOWED_USERS` from the systemd service.

If the development process is killed without running its cleanup trap, restore production with:

```bash
systemctl --user start piss.service
systemctl --user restart piss-tailscale-serve.service
```

After returning to production, reload the PWA once so it installs the production service worker again. Extension changes in a local Pi package still require `/reload` in Pi.

## Module options

| Option | Default | Purpose |
| --- | --- | --- |
| `services.piss.enable` | `false` | Enable PISS |
| `services.piss.package` | flake package | Package to run |
| `services.piss.port` | `4317` | Loopback application and bridge port |
| `services.piss.allowedUsers` | `[]` | Explicit Tailscale login allowlist |
| `services.piss.allowAllTailnetUsers` | `false` | Explicitly permit all identities allowed by tailnet policy |
| `services.piss.tailscale.enable` | `true` | Run the independent userspace node |
| `services.piss.tailscale.hostname` | `"piss"` | Dedicated tailnet hostname |
| `services.piss.tailscale.authKeyFile` | `null` | Optional unattended enrollment key file |

## Security

See [SECURITY.md](./SECURITY.md) for the supported deployment boundary and vulnerability reporting. The architecture and threat model are expanded in [PLAN.md](./PLAN.md).

## License

[MIT](./LICENSE)
