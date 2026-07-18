# Contributing

PISS is security-sensitive. Keep changes narrow, typed, and covered by tests where practical.

## Development

```bash
nix develop
npm ci
npm run check
npm run build
nix flake check
```

Use `npm run typecheck:tsc` when changing TypeScript syntax or configuration to check compatibility with the JavaScript compiler in addition to the native `tsgo` checker.

## Pull requests

- Explain user-visible and security implications.
- Do not weaken loopback binding, Tailscale identity checks, origin checks, payload limits, or runtime validation.
- Never commit credentials, session files, screenshots, uploaded images, or files from `~/.local/state/piss`.
- Update `README.md` when installation or module options change.
- Run all checks before requesting review.

Report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md).
