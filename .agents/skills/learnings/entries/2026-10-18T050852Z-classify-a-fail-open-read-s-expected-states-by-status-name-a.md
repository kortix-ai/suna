---
recorded: 2026-10-18T05:08:52Z
incident_date: 2026-10-14
---
# Classify a fail-open read's expected states by status, name, and message — never by error.code when the catch also wraps database calls

**Rule:** When a fail-open read (transcript capture, inbox transcript read) needs to split "expected stopped/gone/cold runtime state" from "unexpected failure", classify by HTTP status, error name, or message text — the three signals the measured production classes actually arrive as. Do NOT add an error-`code` set to such a classifier when the surrounding `try` also interleaves database work: Postgres errors carry `code: 'ECONNRESET'` / `'ECONNREFUSED'` too, and a code-based family logs a database outage as an expected runtime degrade (info), hiding an incident-class signal. Code-based families are safe only in a try scope that makes only provider calls (the precedent: `runtime-wake-fence.ts`'s `isAmbiguousRuntimeStartError`).

**Trigger surface:** Writing or extending an "is this failure expected?" classifier for any catch block that wraps both runtime/HTTP reads and database calls — transcript capture, inbox reads, any mirror/backfill path.

**Incident:** 2026-10-14, prod API v0.14.x. `[transcript-mirror] sub-agent read failed` warned 637 times in four days (284 in one hour; one capture paid 60 consecutive failed reads against a dying box) and `[session-lifecycle] inbox transcript read failed` warned 156 times — every measured class (proxy 503/404/502, `platinum … expose -> 409` sandbox_not_running, `The operation timed out.`, `fetch failed`) was an expected fail-open state, warning on the platform working as designed. The fix (`apps/api/src/projects/lib/runtime-read-failure.ts`) downgrades the expected classes to info and stops the sub-agent walk at the first expected failure; the first draft classified by `code`, which would have mislabeled Postgres outages — caught in self-review, cut before the PR.

**Enforcement:** `apps/api/src/projects/opencode-unreachable-cause.test.ts` — the "an error-code shape alone is NOT expected" test pins that a Postgres-shaped error (`code: ECONNREFUSED/ECONNRESET/42P01`) stays out of the expected family and keeps its warn; the expected-state tests pin each measured class (409 expose, 404/502/503/504 reads, TimeoutError/AbortError, transport messages, `[proxy] no sandbox row`). Run: `bun test --env-file=scripts/test.env --isolate src/projects/opencode-unreachable-cause.test.ts` from `apps/api`.
