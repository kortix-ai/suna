---
recorded: 2026-09-16T16:51:46Z
incident_date: 2026-09-16
commit: 7c98317cfe
---
# A queued prompt must never spend the dead-letter budget on a path that is simply down

**When:** classifying a failed delivery. `postPrompt` collapsed "nobody
answered for the box" into the same `failed` as "the daemon answered and
refused", so a spent deadline always reported `pending` — which
`executeQueuedContinue` retries on `markCommandFailed`'s `attempts < 5` with a
2 s ladder. Five attempts is about five minutes, after which the user's typed
message is ABANDONED and their bubble reads `Not sent - delivery outcome
pending`. The `unreachable` ladder already existed for exactly this case:
attempts refunded, 30 s / 120 s / 480 s backoff, a fresh idempotency key, and
instant re-arm when a wake confirms the runtime is back.

**Rules.** (1) A retry class is a claim about the FAILURE, not about the call
that returned it — 502/503/504 and a thrown fetch are the path being down, not
the prompt being wrong. (2) `last_error` is customer-facing copy, not a log
line: `delivery outcome: pending` told a paying customer nothing and they
mailed support to ask what it meant. (3) The freshest verdict decides — a path
that comes back and then refuses on its own terms is `pending` again.

*Enforcer:* `deliver.test.ts` (4 cases), `DELIVERY_FAILURE_COPY` in
`session-lifecycle/types.ts`.
