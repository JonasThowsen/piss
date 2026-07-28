# Contributing

PISS is security-sensitive. Keep changes narrow, typed, and covered by tests where practical.

## Development

```bash
nix develop
npm ci
npm run check
npm run test:browser
npm run build
npm run build:v2
nix flake check
nix build .#piss
nix build .#piss-v2
```

`npm run typecheck` uses the pinned stable TypeScript 7 native Go compiler (`tsc`).

## Pull requests

- Explain user-visible and security implications.
- Do not weaken loopback binding, Tailscale identity checks, origin checks, payload limits, or runtime validation.
- Never commit credentials, session files, screenshots, uploaded images, or files from `~/.local/state/piss`.
- Update `README.md` when installation or module options change.
- Run all checks before requesting review.

Report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md).
