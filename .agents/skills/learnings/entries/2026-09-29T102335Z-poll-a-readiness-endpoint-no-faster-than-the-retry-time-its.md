---
recorded: 2026-09-29T10:23:35Z
incident_date: 2026-09-29
---
# Poll a readiness endpoint no faster than the retry time its answer names

**Rule:** When a readiness/lifecycle answer names a time the server will itself
retry (`failure.evidence.next_retry_at`), the client polls AT that time, not on
its own faster cadence. And when consecutive answers repeat unchanged, the poll
interval stretches — an answer that says nothing new does not earn a re-request.
A poll cadence is a load decision, not a latency one: every repeat request costs
auth, IAM, billing, a row read, and an audit row, and the cost lands on the
whole fleet's database, not on the one wedged session.

**Trigger surface:** editing a client poll loop over a control-plane endpoint
(`useSession`'s `/start` query, `ensureReady()`, mobile's `connect-step`), or
adding a server answer that names a cooldown without checking who reads it.

**Incident:** 2026-09-26 through 2026-09-29, prod. One workspace's wedged
sandboxes (a Platinum provider wedge answering 409/503) were `/start`-polled at
~8k calls/hour for 3.5 days because the poller re-fired every 1.5s regardless of
the answer. Each call is a ~8s server long-poll that re-resolves the sandbox
every 200ms. The storm multiplied audit-ingest writes whose per-session
hash-chain lock convoy timed out at 2-4k warns/hour, and the fleet's DB routes —
including the polled `GET /sessions/:id/turn` — saw p95 rise from 273ms to
1-2.8s while p50 halved. Fixed by PR #8197 (KRTX-385): honor `next_retry_at`,
stretch on an unchanged answer, reset on any change.

**Enforcement:** `packages/sdk/src/react/use-session.test.ts` — the
`shouldPollSessionStart` cooldown tests and the `sessionStartRefetchIntervalMs`
stretch/reset/TTL tests fail if a poll cadence ignores the server's retry time
or re-hammers an unchanged answer.
