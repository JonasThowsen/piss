# Production cutover

This runbook records the one-time promotion of the OCaml implementation to the
stable `main` branch and `piss.<tailnet>.ts.net` origin.

## Invariants

- Keep the durable OCaml registry and every independently supervised worker in
  `~/.local/state/piss-ocaml` unchanged.
- Reuse the stable `piss` Tailscale machine identity; do not create a new node
  with the same hostname.
- Never run two `tailscaled` processes from copies of one identity.
- Roll back the application package without moving the stable Tailscale identity
  away from `piss-tailscale`.

## Identity migration

The retired service stored the stable identity in
`~/.local/state/piss/tailscale`. Before deploying the new module:

1. Verify the `piss` peer is offline and `piss-ocaml` is the only active Piss
   node.
2. Back up `~/.local/state/piss/tailscale` and
   `~/.local/state/piss-ocaml-tailscale/tailscale` with modes preserved.
3. Copy the offline stable identity to
   `~/.local/state/piss-tailscale/tailscale` with modes preserved.
4. Deploy with `hostname = "piss"`, `stateName = "piss-tailscale"`, and the
   exact production origin in `allowedOrigins`.

The existing `piss-ocaml-tailscaled.service` is then restarted against the
migrated stable identity. Its `tailscale-up` unit reconciles the hostname before
Tailscale Serve publishes loopback port 4318.

## Verification

- `piss.tailb61fd1.ts.net` is online and owns the expected Tailscale IP.
- `piss-ocaml.tailb61fd1.ts.net` is offline.
- Tailscale Serve proxies `/` to `http://127.0.0.1:4318`.
- `/health` reports the deployed immutable package.
- `/`, `/app.js`, `/styles.css`, `/manifest.webmanifest`, and
  `/service-worker.js` return `Cache-Control: no-store`.
- Chromium accepts the manifest, controls the page with the network-only worker,
  and has no `piss-shell-*` caches.
- A state-changing request from the stable HTTPS origin succeeds.
- Existing active workers remain running through the control-plane replacement.

## Rollback

Re-pin the previous application package and redeploy while retaining
`hostname = "piss"` and `stateName = "piss-tailscale"`. Do not restore the
parallel `piss-ocaml` address as the public endpoint. If the migrated identity
cannot authenticate, stop its daemon before restoring either backed-up state
directory; never start both copies.
