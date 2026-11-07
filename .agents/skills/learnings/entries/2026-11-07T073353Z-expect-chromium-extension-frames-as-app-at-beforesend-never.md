---
recorded: 2026-11-07T07:33:53Z
incident_date: 2026-11-07
---
# Expect Chromium extension frames as app:/// at beforeSend, never as chrome-extension://

**Rule:** Write a Sentry-gate extension-noise rule against the `app:///<file>` shape. `NextjsClientStackFrameNormalization` (`@sentry/nextjs` client) replaces every frame's URL origin, `chrome-extension://<id>` included, with `app://` before `beforeSend` runs, so a `chrome-extension://` prefix check never sees a Chromium frame there.

**Trigger surface:** Adding or reviewing a rule in `packages/ui/src/internal/lib/browser-noise/rules/`.

**Incident:** 2026-11-07, KRTX-4430: an extension's main-world bridge (`app:///dragOutMainWorldBridge.<hash>.js`) threw `Cannot read properties of undefined (reading 'connect')` on the marketing home page. 1 occurrence, 0 users. The `extension-frame` rule did not match it.

**Enforcement:** `packages/ui/src/internal/lib/browser-noise/drag-out-bridge.test.ts` pins the observed `app:///` frame shape. None yet for the rewrite itself: a test that runs the SDK integration on a `chrome-extension://` frame.
