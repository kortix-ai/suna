---
recorded: 2026-10-29T18:21:18Z
incident_date: 2026-10-29
---
# Anchor Talisman onboarding noise on its exact message and injected response frame

**Rule:** Match the exact Talisman onboarding message with its injected `app:///page.js` `ne.handleResponse` frame. Preserve resolved first-party frames.

**Trigger surface:** Browser telemetry noise classification.

**Incident:** KRTX-3678: two production unhandled rejections, zero identified users. The wallet extension's onboarding rejection escaped the extension-protocol filter because its injected script uses a synthetic page URL.

**Enforcement:** `packages/ui/src/internal/lib/browser-noise/talisman.test.ts` exercises the Sentry gate with the observed frame shape, unrelated errors, absent frames and first-party frames. The golden rule-table fixture proves the new rule independently.
