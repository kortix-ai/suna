---
recorded: 2026-09-29T01:08:10Z
incident_date: 2026-09-29
---
# A noise rule that reads a thrown-object property is only as good as the hint wiring on every capture path

**Rule:** When a Sentry noise rule depends on a property of the thrown error object (a Next.js `digest`, an `error.cause`), the classifier sees it only through `hint.originalException`. Thread the hint through `beforeSend` in every Sentry config — client, server, AND edge — in the same PR that adds the rule. Never assume the SDK serializes the property: @sentry/core does not serialize `digest`.

**Trigger surface:** `apps/web/sentry.*.config.ts` and `apps/web/src/lib/browser-error-noise*` — adding or auditing a noise rule, or touching any Sentry capture path.

**Incident:** 2026-09-25→26, prod v0.13.31–v0.13.33. The `next-recovery-bailout` rule (PR #7707, KRTX-230) stopped the `Minified React error #419` 404-recovery class from paging, but the edge config dropped the hint, so the rule was inert on that gate. The same class re-detected under new release-scoped patterns (KRTX-628): 23 occurrences / 2 issues / 2 worker cycles for one missing argument. Live capture on prod confirmed the digest rides the thrown object and the client gate already suppressed it.

**Enforcement:** `apps/web/src/lib/browser-error-noise.test.mts` covers the classifier, not the configs. A source-scan tripwire is the missing enforcer — none yet: assert every `apps/web/sentry.*.config.ts` `beforeSend` passes its `hint` to `shouldIgnoreSentryNoiseEvent`.
