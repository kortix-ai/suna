---
recorded: 2026-10-29T17:51:19Z
incident_date: 2026-10-29
---
# Match wallet rejection payloads exactly rather than suppressing their shared Sentry summary

**Rule:** Inspect the serialized rejected value on every recurrence. Match an exact code/message pair and preserve first-party frames.

**Trigger surface:** Browser Sentry filters for synthetic plain-object promise rejections.

**Incident:** KRTX-2150 recurred after PR #9922. The same summary represented a different payload: code 4001 and the wallet missing-account message, not provider-disconnected code 4900.

**Enforcement:** `packages/ui/src/internal/lib/browser-noise/wallet-account.test.ts` pins the captured payload, nearby payloads, and actionable frames.
