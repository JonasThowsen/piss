# Contributing

PISS is security-sensitive. Keep changes narrow, typed, and covered by tests where practical.

## Development

```bash
nix develop
npm ci
npm run check
npm run test:browser
npm run build
nix flake check
nix build .#piss
```

`npm run typecheck` uses the pinned stable TypeScript 7 native Go compiler (`tsc`).

## Pull requests

- Explain user-visible and security implications.
- Do not weaken loopback binding, Tailscale identity checks, origin checks, workspace authorization, payload limits, or runtime-generation validation.
- Never commit credentials, Pi session files, screenshots, uploaded images, or files from `~/.local/state/piss`.
- Update `README.md` when installation or module options change.
- Run all checks before requesting review.

Report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md).
