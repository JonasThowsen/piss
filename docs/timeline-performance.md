# Timeline performance fixture

Run the current Chromium timeline and session fixture through the Nix shell:

```sh
nix develop . -c just build
nix develop . -c dune build --force @session-browser-test
```

The active fixture is `src/test/timeline_browser.mjs`; it verifies paginated history, retention bounds, scroll anchoring, safe Markdown behavior, and permission reconstruction against Nix-provided Playwright and Chromium.

## Historical profile captured before windowing

- Rendered projection: 2,020 ms
- Composer fill: 710 ms
- Message articles in DOM: 750
- Important limitation: the old browser merge cap discarded 9,250 fixture events, so this was not actually preserving a 10,000-event client projection.

## Historical profile after windowing and lazy Markdown

- Rendered projection: 415 ms
- Composer fill: 144 ms
- Message articles in DOM: 180
- All 10,000 projected events remain in reducer state; only the active 180-row window is mounted.

These timings came from the retired TypeScript fixture and remain only as historical observations, not current performance budgets.
