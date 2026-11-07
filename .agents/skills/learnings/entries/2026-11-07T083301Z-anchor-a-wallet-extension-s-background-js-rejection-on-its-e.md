---
recorded: 2026-11-07T08:33:01Z
incident_date: 2026-11-07
---
# Anchor a wallet extension's background.js rejection on its exact message and that frame

**Rule:** Match the exact Shield wallet lock message with its `app:///background.js` frame. Preserve resolved first-party frames; never filter `background.js` alone.

**Trigger surface:** Browser telemetry noise classification.

**Incident:** KRTX-4433: four production unhandled rejections, zero identified users. The locked Shield wallet's background script rejected a dapp request; the extension-protocol filter cannot see it because Sentry reports the script as the synthetic `app:///background.js`.

**Enforcement:** `packages/ui/src/internal/lib/browser-noise/shield-locked.test.ts` and the Sentry transport test in `apps/web/sentry.client.config.test.ts` cover the observed frames, other messages, absent frames, bundle frames and first-party frames. The golden rule-table fixture proves the rule on its own.
