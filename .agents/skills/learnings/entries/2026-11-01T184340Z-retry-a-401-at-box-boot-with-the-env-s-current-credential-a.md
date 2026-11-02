---
recorded: 2026-11-01T18:43:40Z
incident_date: 2026-11-01
---
# Retry a 401 at box boot with the env's current credential; a wake races the session lease

**Rule:** A daemon call made at boot never reads a 401 as final. The API refuses a session credential until the sandbox row is `provisioning`/`active` again (`Session token is not active`), and a wake can install a new credential right after (KRTX-2545). Send the request again, about 1 s apart for up to ~15 s, and read the token from the env on every attempt. Only then fall back.

**Trigger surface:** Adding or changing a daemon → API call that runs while the box boots or wakes: the session-log manifest and restore, the initial-turn claim, config release, audit and projection relays.

**Incident:** 2026-11-01, near-miss found in prod CloudWatch. From 2026-10-30 to 11-01, 30 boots in 20 sessions (about 3.5 % of boots) got `401` on `GET …/log/manifest`. The boot read that as "no reconcile" and skipped the session-log restore. The same boxes' next call answered 200 1–9 s later. All 20 boxes still had their native store, so no history was lost. A fresh or stateless box would have booted with an empty model history. PR #11434 added the retry, verified on dev with a box whose row was held at `stopped` for 16 s: 9 × 401, then 200.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/session-log-boot.test.ts` ("a wake that beats the sandbox lease", "a new credential that arrives during the wait", "a 401 that outlasts the wait"). None yet for the other boot calls: the initial-turn claim still fails on a single 401 (`[boot] initial-turn claim failed`, seen on the same dev run).
