---
name: piss-ui-verification
description: Verify meaningful frontend changes in the PISS-managed local browser and share representative visual evidence. Use when implementing or reviewing a local web UI.
---

# PISS UI Verification

After meaningful frontend changes, when practical:

1. Inspect the repository and start its existing local development command without asking the user to operate it.
2. Open the emitted loopback URL with `piss_browser_navigate`.
3. Use `piss_browser_snapshot` and accessible interactions to exercise the affected flow.
4. Check the resulting state rather than assuming the dev server or UI worked.
5. Capture one representative final screenshot with `piss_browser_screenshot`; PISS publishes successful captures automatically.
6. When motion or an interaction sequence is itself material, use one short `piss_browser_video_start` → actions → `piss_browser_video_stop` recording instead of many screenshots.

Prefer structured snapshots for routine actions and screenshots for static final states. Do not capture every intermediate step. Record video only when it communicates behavior that a final still cannot, and keep the sequence deliberate and short.
