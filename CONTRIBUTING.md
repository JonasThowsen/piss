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

The development shell provides OCaml 5.5, Dune, opam, formatters, native
libraries, and the temporary browser build tools. npm supplies only the React
runtime until the browser shell moves to Bonsai.

## Pull requests

- Explain user-visible and security implications.
- Do not weaken loopback binding, Tailscale identity checks, origin checks, workspace authorization, payload limits, or runtime-generation validation.
- Never commit credentials, Pi session files, screenshots, uploaded images, or files from `~/.local/state/piss`.
- Update `README.md` when installation or module options change.
- Run all checks before requesting review.

Report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md).
