---
name: learnings
description: "The project's hard-won incident learnings — durable rules extracted from real outages and near-misses, each with the incident that taught it. Load WHENEVER you write or review a DB migration or schema change, touch deploy/release workflows (.github/workflows/deploy-*, promote.yml, vercel config), plan a promote/release, respond to a prod incident, or when another skill references a learning. ALSO load after resolving any incident: this file is append-only and every new incident MUST deposit its rule here."
---

# Project learnings

Rules paid for with real downtime. Each entry: the rule first, the incident that
taught it second. This register is **append-only** — when an incident or
near-miss resolves, add its rule here in the same session, newest first. Keep
entries under ~8 lines; deep detail goes in the incident's memory/RCA and is
linked, not inlined.

## How to add a learning

1. Write the RULE as an imperative a developer can obey while coding.
2. Name the trigger surface (what someone is doing when it applies).
3. One-line incident citation (date, version, blast radius).
4. Reference any enforcing automation (lint, CI gate, workflow) — a learning
   with an enforcer is a fact; one without is a TODO to build the enforcer.

## Register

### An identity write that ESTABLISHES a session is the answer for a fetch it overtakes; only a CLEAR is a boundary (2026-09-05)

**When:** guarding a cached credential with a generation/epoch counter, or
adding any "discard the in-flight result" rule to a token cache.
`#7065` (2026-08-31) made `getSupabaseAccessToken()` return `null` whenever
`authEpoch` moved while its fetch was in flight. EVERY authoritative write
moved it, including `AuthProvider`'s own `setCachedAuthToken(session.access_token)`
at hydration. The SDK request path asks for the token exactly once with no
retry (`withTokenRetry` defaults to one attempt), so any request whose token
fetch was still in flight when hydration wrote got `null`, the SDK answered a
synthetic `AuthError` without sending the request, and the project boundary
mapped the status-less error to its terminal screen: **"This project didn't
load. The request failed before we could check your access."** Sibling
queries (sessions sidebar) stayed on skeletons for the same reason. Which
call resolved first was a lock-order coin flip inside supabase-js, so it was
"some loads", not all. **Rules.** (1) A cache write that establishes an
identity with no clear since the fetch began hands that identity to the
waiting caller; only a clear (`setCachedAuthToken(null)`: sign-out, 401,
stale session) is a boundary that answers `null` — track the clear's epoch
separately (`lastClearEpoch`). (2) Before making a token getter return
`null` on any path, read the callers: a getter with a no-retry consumer
turns every `null` into a failed request. (3) A boundary that renders a
TERMINAL screen for a status-less error must be reproduced by watching the
network tab: the signature here was the error screen with NO request to the
route it names. *Incident:* dev only, 2026-08-31 → 2026-09-05; staging and
prod never carried #7065. Fixed in PR #7120.
*Enforcer:* `apps/web/src/lib/auth-token.test.ts` — three hydration-race
cases plus "clear → new token, both mid-flight: still null".


### A durable FIFO has one order key and advances at one boundary (2026-09-03)

**When:** implementing a queue whose enqueue requests can race. Define one total
order and reuse it for listing, admission, claims, repair, and promotion. Never
mix client send time with database insert time. Promote the next item only after
the current turn closes; delivery-time promotion races terminal promotion and
loses the wake. *Incident:* queued prompts reversed after hydration, and the
next prompt paused up to the 2-second admission backoff. *Enforcer:*
`inbox-order.test.ts`, `integration-prompt-inbox.test.ts`, and
`queued-continue-inbox-delivery.test.ts`.

### A read that fails is not an admin decision — health flags fail open (2026-09-02)

**When:** writing any code path that answers "is the platform in maintenance /
locked down / degraded?", especially one an edge proxy polls.
`getEdgeMaintenanceConfig()` returned a synthetic `level: 'blocking'` whenever
the Vercel Edge Config read threw *or the key was simply absent*. The
`api-router` worker polls that route as `MAINTENANCE_STATE_URL` and answers
every non-read-only request to `api.kortix.com` with a 503 carrying that
config's `message`. So one failed network call locked production writes, and
users got `ApiError: Kortix is temporarily unavailable. Service will resume
automatically.` — the string that only that fallback produces. Nobody had
touched the admin toggle. **The rule:** an unknown state is `none`. Distinguish
"the store says nothing" (normal operation) from "the read failed" (serve the
last value actually read, else normal operation). A lockdown that must survive
the flag store being down belongs in the consumer as an explicit override
(`MAINTENANCE_LEVEL_OVERRIDE` on the worker), never as a failure default.
Commit 005fd6a4c9 fixed three of these paths on 2026-08-02 and missed the
fourth and fifth — when you flip one fail-closed path, grep for every producer
of the same message. *Incident:* prod, Better Stack `Kortix Frontend`: 1,000+
`ApiError` occurrences over ~2 days; the client-side twin
(`automaticMaintenanceConfig()`) additionally navigated users off a healthy app
to `/maintenance` on one failed poll. Enforcement:
`maintenance-store.test.ts` edge-gate cases, `maintenance-client.test.ts`
"stays out of maintenance after a status request failure".

### A runtime that only updates by pulling never updates a box that predates the puller (2026-09-01)

**When:** designing or relying on any "the box converges on the API" mechanism
(runtime-assets, daemon self-update). A daemon built before the pull code
exists never pulls; restart/resume keep the VM and warm-fork keeps the disk, so
every box from before the cutover is a fossil until the CONTROL PLANE reaches
into it through the provider's own exec channel. Ship the push path with the
pull path, and probe the fleet for boxes whose `/kortix/health` has no `runtime`
block. *Incident:* OpenCode's 48-bit message-id rollover (2026-08-14) silently
broke every pre-wrap session on OpenCode < 1.18.15; the fix (1.18.15) never
reached July boxes — 9 prod sessions dead 19 days, 4 h 15 m zombie turns.
*Automation:* `legacy-runtime-bootstrap.ts` scheduled from `box-reaper` (PR #7088);
`scripts/legacy-runtime-sweep.ts --dry-run` lists what is still legacy.

### Verify "converged" by what is RUNNING, not by what was installed (2026-09-01)

**When:** any install-then-restart flow. The daemon memoised its OpenCode binary
path at boot, installed 1.18.23, restarted — and kept spawning 1.17.11. The
install log said success; `readlink /proc/<pid>/exe` said otherwise.
*Automation:* `restart()` drops the memoised path (opencode.ts); the bootstrap
relaunches once more after an `updated` boot pass and its health wait requires a
FRESH daemon (`uptime_s` small), never the one just killed.
