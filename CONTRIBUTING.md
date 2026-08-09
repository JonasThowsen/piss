# Contributing

PISS is security-sensitive. Keep changes narrow, typed, and covered by tests where practical.

## Development

```bash
nix develop
npm ci
just check
nix flake check
nix build .#piss
```

The default development shell provides OCaml 5.5, Dune, formatters, and the
native libraries. `just build` enters the separate OCaml 5.2 shell used for the
Bonsai browser bundle. npm currently supplies only the Playwright browser test
driver.

## Pull requests

- Explain user-visible and security implications.
- Do not weaken loopback binding, Tailscale identity checks, origin checks, workspace authorization, payload limits, or runtime-generation validation.
- Never commit credentials, Pi session files, screenshots, uploaded images, or files from `~/.local/state/piss`.
- Update `README.md` when installation or module options change.
- Run all checks before requesting review.

Report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md).
