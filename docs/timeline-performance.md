# Timeline performance fixture

Run the repeatable Chromium fixture through the Nix shell:

```sh
XDG_CACHE_HOME=/tmp/piss-nix-cache nix develop . -c \
  npx playwright test -g '10,000-event timeline benchmark'
```

The fixture is `browser-test/workbench.spec.ts` (`10,000-event timeline benchmark stays bounded and interactive`). It loads 10,000 projected message events, waits for the latest event, edits the composer, and asserts that fewer than 400 message rows exist in the DOM.

## Profile captured before windowing

- Rendered projection: 2,020 ms
- Composer fill: 710 ms
- Message articles in DOM: 750
- Important limitation: the old browser merge cap discarded 9,250 fixture events, so this was not actually preserving a 10,000-event client projection.

## Profile after windowing and lazy Markdown

- Rendered projection: 415 ms
- Composer fill: 144 ms
- Message articles in DOM: 180
- All 10,000 projected events remain in reducer state; only the active 180-row window is mounted.

These timings are local observations, not universal performance budgets. The test uses deliberately generous deterministic limits (`<10s` load, `<1s` composer fill, `<400` rows) to catch regressions without depending on one machine's speed.
