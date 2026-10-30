---
recorded: 2026-10-21T03:50:37Z
incident_date: 2026-10-21
---
# Return a retryable mirror outcome when base moves exhaust freshness retries

**Rule:** Preserve the bounded freshness guard, but throw a typed retryable error when concurrent base moves exhaust it. Never serve the invalidated checkout or classify arbitrary error text as transient.

**Trigger surface:** `projects/git/mirror.ts` refresh locks, invalidation epochs and the HTTP error classifier.

**Incident:** 2026-10-21, KRTX-2970. One production API occurrence of repeated mirror invalidation escaped as a generic 500 and paged Better Stack instead of returning a retryable outcome.

**Enforcement:** `mirror-invalidated-flight.test.ts` proves bounded retries and recovery; `unit-http-mirror-busy.test.ts` proves the real HTTP handler returns 503 with Retry-After and no capture, including a wrapped cause, while generic errors still page.
