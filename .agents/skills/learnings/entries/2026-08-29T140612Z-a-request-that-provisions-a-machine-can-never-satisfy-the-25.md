---
recorded: 2026-08-29T14:06:12Z
incident_date: 2026-08-29
commit: 1d6e43c051
---
# A request that provisions a machine can never satisfy the 25s deadline — return status and do the work out of band

**When:** writing or reviewing any endpoint that creates/resumes a sandbox, VM,
or other multi-second resource, especially one a poller calls.
`POST /sessions/:id/environment/ensure` awaited a full Daytona provision inside
the request; `middleware/request-deadline` kills every request at 25s, and the
loser of the claim waited a further 120s (`CLAIM_WAIT_MS`). So the FIRST compute
tool call of every pi session got 503 after 503 until the worker's 180s budget
expired: `write` sat at `running` for three minutes and then failed, on a
session that was otherwise healthy. The caller was ALREADY a poller
(`LazyKortixEnv.attach` re-asks every 2s until `active`) — the blocking wait
bought nothing and cost everything.
**The rule:** claim, start the work detached, return the current status. And
detaching costs one thing the request-bound version got free — **a claim whose
owner dies must expire**: nothing else ever re-claims a `provisioning` row, so
add a staleness window (`PROVISION_STALE_MS`) or one crash wedges that resource
forever. Diagnostic: a 503 whose `duration` is exactly the deadline, repeating
at the caller's poll interval.
*Incident:* pi.kortix.com, every session, until #7024. No prod impact — pi is
preview-only. *Enforcer:* `session-environment.test.ts` pins that `ensure` never
awaits the work and that a stale claim is re-claimable.
