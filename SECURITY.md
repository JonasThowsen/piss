# Security policy

PISS is a privileged remote-control interface. A compromised PISS session can instruct Pi to execute commands, read files available to the user, and modify source code.

## Supported deployment

The only supported production boundary is:

1. the PISS application binds to loopback;
2. the NixOS module's independent Tailscale node provides HTTPS;
3. Tailscale Serve supplies authenticated identity headers;
4. `services.piss.allowedUsers` restricts browser access.

The following are explicitly unsupported:

- Tailscale Funnel;
- direct public internet exposure;
- a reverse proxy that permits clients to forge Tailscale identity headers;
- a non-loopback `PISS_HOST`;
- production use with `PISS_DEV_BYPASS_AUTH=1`.

PISS deliberately refuses non-loopback binds and refuses the development bypass when `NODE_ENV=production`. In development, identity may be bypassed but browser WebSockets still require the configured local Vite origin (`PISS_DEV_ALLOWED_ORIGINS`, or the loopback defaults for `PISS_DEV_WEB_PORT`).

## Secrets and local data

- The bridge credential is generated at `~/.local/state/piss/bridge-token` with mode `0600` and must never be committed.
- Tailscale state is stored under `~/.local/state/piss/tailscale` and must never be copied into the repository.
- Use a secret manager for `services.piss.tailscale.authKeyFile`; never put an auth key in Nix source.
- Text drafts are stored in the browser's local storage for up to 30 days. Do not use an untrusted browser profile.
- Image bytes are validated at both trust boundaries and are not retained in the server's history cache.
- Web Push VAPID keys and opted-in device subscriptions are stored under `~/.local/state/piss` with mode `0600`. Push delivery necessarily reveals the device's push endpoint and an encrypted payload to its browser vendor; PISS payloads contain only session label, branch, completion state, and session ID, never conversation content or credentials.

## Reporting a vulnerability

Please use GitHub's **Report a vulnerability** feature under the repository's Security tab. Do not open a public issue for authentication bypasses, credential exposure, command-routing flaws, or cross-site scripting.

Include:

- the affected commit or release;
- deployment details;
- reproduction steps;
- impact;
- any suggested mitigation.

You should receive an acknowledgement within seven days. There is currently no bug bounty.

## Supported versions

Until stable releases are published, only the latest commit on `main` receives security fixes.
