---
recorded: 2026-10-28T04:23:54Z
incident_date: 2026-10-28
---
# Use a CSP-safe HEIC decoder instead of enabling unsafe-eval

**Rule:** Use `heic-to/csp` for browser HEIC conversion. Do not add `unsafe-eval` to production CSP.

**Trigger surface:** HEIC attachment thumbnails and file previews in `@kortix/ui`.

**Incident:** 2026-10-28, KRTX-3580: heic2any's blob worker called `new Function` during initialization. Production CSP rejected it at worker line 2:1320381. The conversion never resolved.

**Enforcement:** `apps/web/src/lib/security/heic-convert.browser.test.ts` converts a synthetic HEIC in Chromium under the real production CSP and decodes the returned JPEG. The old decoder fails with the same EvalError and column as production.
