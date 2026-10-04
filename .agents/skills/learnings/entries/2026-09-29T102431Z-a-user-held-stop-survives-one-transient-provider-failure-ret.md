---
recorded: 2026-09-29T10:24:31Z
incident_date: 2026-09-29
---
# A user-held stop survives one transient provider failure: retry once, bounded, and log the cause

**Rule:** a manual stop a user is holding the button for must survive one
transient provider failure. Retry the provider stop once, bounded (about a
second later), with the benign classifiers still guarding every attempt, and
log each failed attempt — a stop 502 the caller never logs turns the cause
into guesswork from response durations. A persistent failure still fails
honestly (502, row untouched); the reaper's next pass remains the backstop.

**Trigger surface:** writing or reviewing `stopSession`
(`apps/api/src/services/sessions/lifecycle/stop.ts`) or any user-facing caller
of a sandbox provider's `stop()` — including the reaper path, which retries
on its next pass instead.

**Incident:** 2026-09-28/29 platform capacity incidents degraded the sandbox
platform API (intermittent 502/503/504 HTML error pages on the stop ACK;
transitions outlasting the 10s confirm window). Prod `POST …/sessions/:id/stop`
returned 17 5xx of 255 requests in the worst hour against a 0/h baseline
(KRTX-520); the 502s carried the provider error to the client only, so no log
named the cause. The `last state: stopping` half was already fixed as a
lifecycle transition (see the stop-confirm classification entry, 2026-09-29).

**Enforcement:** `apps/api/src/services/sessions/lifecycle/__tests__/stop.test.ts`
— a fail-then-succeed stop commits at 200 after exactly two provider calls; a
fail-then-fail stop returns 502 with the last provider error; a benign first
answer never retries.
