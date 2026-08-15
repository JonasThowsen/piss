# Web performance guidelines

PISS treats interaction responsiveness as an architectural property, not a final polish pass. Bonsai's incremental graph only helps when state dependencies match the visible ownership boundaries in the UI.

## Core invariant

A local interaction must not invalidate an unrelated expensive subtree.

Examples:

- Typing, mention-picker movement, attachment state, and composer menus must not rebuild the timeline, outbox, session rail, or Markdown history.
- Navigation menus and modal state must not rebuild session history.
- A live timeline event may rebuild the affected timeline projection, but must not reset the composer or disclosure state.

Before adding a state dependency, ask:

> Which render computations will this value invalidate?

If a textarea character or menu toggle reaches a large list, move the state or split the computation before merging.

## Bonsai component pattern

### Keep state with its owner

Prefer small, local Bonsai state values over a single application model. Do not pass a full component output or model into a computation that only needs one stable callback or field.

When two surfaces need to share an action, lift the smallest required state or setter. For example, composer notices are owned above the composer so permission actions can update the notice without making timeline rendering depend on the full composer output.

### Isolate expensive VDOM construction

Build expensive surfaces in sibling Bonsai computations whose dependency lists contain only data that can visibly change them. Pass the resulting VDOM nodes upward for composition.

The current timeline pattern is in `web/main.ml`:

- `timeline_content` depends on history, runtime information used by history controls, permission decisions, and copy feedback.
- It does **not** depend on prompt text, picker state, delivery mode, composer notices, attachments, or configuration-menu state.
- `Timeline_view.render` receives the precomputed timeline and outbox nodes.

Do not move `Timeline_entry_view.render_timeline` back into a root `let%arr` that also depends on `Composer.output`.

### Preserve identity

- Give timeline rows and groups stable semantic keys.
- Reuse precomputed VDOM values when their inputs are unchanged.
- Avoid recreating large lists, parsed Markdown, tool-output strings, or callbacks because unrelated state changed.
- Use semantic equality or a Bonsai cutoff when a fresh value is equivalent to the previous value.

### Do not confuse hidden with cheap

CSS-hidden or collapsed content can still consume memory and VDOM diff time. For large disclosures, prefer mounting detailed output only after expansion. If retained history grows beyond the current bounded window, use windowing or virtualization while preserving stable scroll anchors and accessibility.

## Regression coverage

Run the production browser fixture through the Nix shells:

```sh
nix develop . -c just build
nix develop . -c dune build --force @session-browser-test
```

Prefer deterministic invalidation assertions over tight timing thresholds.

`src/test/timeline_browser.mjs` loads a large history and verifies that:

- typing a long prompt does not increment `#timeline[data-timeline-render-count]`;
- opening a composer configuration menu does not increment it; and
- pagination remains bounded and preserves the visible anchor.

`src/test/mention_browser.mjs` also keeps a broad end-user responsiveness check while typing during streamed activity. Timing checks are secondary because runner load can make them noisy; the render-count invariant directly catches the architectural regression.

When adding another expensive surface, add equivalent deterministic instrumentation or an observable invariant. Performance fixtures should exercise realistic upper bounds: hundreds of retained events, tool-heavy activity, streaming, desktop and 390×844 mobile layouts, manual scrolling, and history prepends.

## Review checklist

Before merging browser work, verify:

- [ ] Local state is owned by the smallest relevant component.
- [ ] Expensive computations do not depend on full component records unnecessarily.
- [ ] Typing does not rebuild history, navigation, Markdown, or tool details.
- [ ] Menu and modal toggles do not rebuild unrelated lists.
- [ ] Live updates preserve stable keys, disclosure state, and scroll behavior.
- [ ] Collapsed content is not doing avoidable parsing, formatting, or network work.
- [ ] Browser coverage uses realistic history sizes and includes mobile.
- [ ] Deterministic invalidation checks are preferred over fragile microbenchmarks.
- [ ] `nix develop . -c just check` and `nix build .#piss .#piss-web --no-link` pass.

## Profiling workflow

For an interaction that feels slow:

1. Reproduce it with a production-sized fixture.
2. Separate network latency from browser main-thread work.
3. Compare script, layout, and task time with Chromium performance metrics.
4. Inspect which Bonsai dependencies changed for the interaction.
5. Fix the invalidation boundary before applying CSS or micro-optimizations.
6. Add a deterministic regression assertion for the corrected boundary.
