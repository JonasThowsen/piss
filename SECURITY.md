# Security policy

PISS is a privileged remote-control interface. A compromised PISS session can instruct Pi to execute commands, read files available to the user, and modify source code.

## Supported deployment

The only supported production boundary is:

1. the PISS application binds to loopback;
2. the NixOS module's independent Tailscale node provides HTTPS;
3. Tailscale Serve supplies authenticated identity headers;
4. `services.piss.allowedUsers` restricts browser access;
5. configured workspace roots bound the directories in which PISS may launch Pi.

The following are explicitly unsupported:

- Tailscale Funnel;
- direct public internet exposure;
- a reverse proxy that permits clients to forge Tailscale identity headers;
- a non-loopback `PISS_HOST`;
- production use with `PISS_DEV_BYPASS_AUTH=1`;
- broadly authorizing sensitive home or filesystem roots as workspaces.

PISS refuses non-loopback binds and refuses the development bypass when `NODE_ENV=production`. State-changing production requests also require a matching HTTPS origin.

## Secrets and local data

- Tailscale state is stored under `~/.local/state/piss/tailscale` and must never be copied into the repository.
- Use a secret manager for `services.piss.tailscale.authKeyFile`; never put an auth key in Nix source.
- PISS ownership metadata, workspace registrations, VAPID keys, and push subscriptions are stored under `~/.local/state/piss` with restrictive permissions.
- Pi JSONL transcripts remain in Pi's session storage and may contain prompts, model output, tool results, and paths.
- Text drafts are stored in browser local storage for up to 30 days. Do not use an untrusted browser profile.
- Image count, base64 encoding, signature, and aggregate size are validated before delivery to Pi.
- Web Push reveals the device push endpoint and an encrypted generic payload to the browser vendor. Payloads do not contain prompts, output, workspace names, errors, absolute paths, or credentials.
- The PWA caches only fixed public shell assets; API and session responses are excluded.

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** feature under the repository's Security tab. Do not open a public issue for authentication bypasses, credential exposure, command-routing flaws, workspace escapes, sandbox escapes, or cross-site scripting.

Include the affected commit, deployment details, reproduction steps, impact, and any suggested mitigation. You should receive an acknowledgement within seven days. There is currently no bug bounty.

## Supported versions

Until stable releases are published, only the latest commit on `main` receives security fixes.
