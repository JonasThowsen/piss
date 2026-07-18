# PISS

**PISS** — **Pi sin sidecar** — is a private, mobile-first web control surface for live [Pi](https://github.com/earendil-works/pi-mono) coding-agent sessions.

It streams Pi's native messages and tool events instead of mirroring a terminal. From a phone or laptop you can inspect multiple live sessions, send prompts, steer between tool calls, queue follow-ups, abort work, paste or upload images, and safely resume after browser sleep.

PISS is designed for NixOS and private Tailscale access. Its NixOS module runs the application and an independent userspace Tailscale node, giving it its own URL:

```text
https://piss.<tailnet>.ts.net
```

It does not consume the hosting machine's normal Tailscale Serve configuration.

## Features

- Native Pi message and tool-event streaming
- Prompt, steer, follow-up, and abort controls
- Phone image uploads and desktop clipboard screenshots
- Per-session persistent text drafts
- Mobile session drawer and controlled follow-to-bottom behavior
- Runtime-generation checks against stale commands
- Tailscale identity authentication and optional login allowlist
- Independent Tailscale hostname and HTTPS certificate
- Separate mode-0600 bridge credential
- Reproducible Nix package, NixOS module, and development shell
- Type checking with the TypeScript 7 native Go compiler (`tsgo`)

## NixOS installation

Add PISS as a local flake input while developing it:

```nix
{
  inputs.piss = {
    url = "git+file:///home/jonas/coding/piss";
    inputs.nixpkgs.follows = "nixpkgs";
  };
}
```

Import and enable the module:

```nix
{ inputs, ... }:
{
  imports = [ inputs.piss.nixosModules.default ];

  services.piss = {
    enable = true;
    allowedUsers = [ "you@example.com" ];
    tailscale.hostname = "piss";

    # Optional for unattended first login. The file must be readable by the
    # desktop user. Without it, use piss-tailscale-login once.
    # tailscale.authKeyFile = "/run/secrets/piss-tailscale-auth-key";
  };
}
```

Apply the configuration:

```bash
sudo nixos-rebuild switch --flake ~/nixos#nixos
```

### First Tailscale login

Without an auth key file, authenticate the independent node once:

```bash
piss-tailscale-login
```

Open the login URL, then inspect the services:

```bash
systemctl --user status piss piss-tailscaled piss-tailscale-serve
journalctl --user -u piss-tailscale-serve -f
```

With MagicDNS and HTTPS certificates enabled, PISS is available at:

```text
https://piss.<tailnet>.ts.net
```

The node state persists under `~/.local/state/piss/tailscale`. A hostname collision may cause Tailscale to add a suffix; remove the old node or rename it in the admin console if the exact `piss` hostname is already occupied.

## Install the Pi bridge

For development, install the repository directly:

```bash
pi install /home/jonas/coding/piss
```

New Pi processes load the bridge automatically. Run `/reload` once in sessions that were already open. Since this is a local Pi package, extension source changes are picked up after `/reload` without reinstalling it.

The bridge connects only over loopback and reads its credential from:

```text
~/.local/state/piss/bridge-token
```

## Development

Enter the reproducible shell and install the locked npm dependencies:

```bash
nix develop
npm install
```

Useful commands:

```bash
npm run check     # TypeScript 7 native Go checker + tests
npm run build     # production server and browser assets
npm run dev       # local server and Vite, explicit auth bypass
nix flake check
nix build .#piss
```

The development server is loopback-only. `npm run dev` explicitly enables local authentication bypass; production refuses that combination when `NODE_ENV=production`.

## Module options

- `services.piss.enable`
- `services.piss.package`
- `services.piss.port` — default `4317`
- `services.piss.allowedUsers` — Tailscale login allowlist
- `services.piss.tailscale.enable` — independent userspace node, enabled by default
- `services.piss.tailscale.hostname` — default `piss`
- `services.piss.tailscale.authKeyFile` — optional unattended enrollment

## Security

Remote Pi control is effectively remote access to the host user account. PISS therefore:

- refuses non-loopback application bind addresses;
- requires Tailscale identity on browser HTTP and WebSocket requests;
- validates WebSocket origins;
- uses a separate local bridge credential;
- validates command targets against the active runtime generation;
- limits command and image payloads;
- validates image signatures rather than trusting MIME declarations;
- ships no third-party browser scripts;
- does not support Tailscale Funnel.

Do not expose the loopback server through an unauthenticated proxy. See [PLAN.md](./PLAN.md) for the architecture and threat model.
