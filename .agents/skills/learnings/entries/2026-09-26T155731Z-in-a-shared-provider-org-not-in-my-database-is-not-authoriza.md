---
recorded: 2026-09-26T15:57:31Z
incident_date: 2026-09-18
---
# In a shared provider org, "not in my database" is not authorization to delete

**Rule:** when reclaiming provider-side artifacts (sandbox provider snapshots,
templates, images) in an org shared across dev/staging/prod/laptops on one API
key, an artifact name absent from your own environment's database means
*another environment owns it*, not *it is dead*. Idle time is a heuristic,
never authorization. Anything a rollback/restore path reads must use bounded
retention (active + N recent), never supersession or idleness alone.
Namespace every provider-side artifact by the owning environment
(`INTERNAL_KORTIX_ENV` or equivalent) at creation time, or verify against the
owning environment's database before any cross-env delete. Two provider facts
that invalidate an obvious "verify then delete" plan: a delete call can return
`200` while the artifact is still `pending`/`building` and nothing happened
(re-read the state — `200` is not "deleted"), and a create call returning
`200 pending` proves only acceptance, not success (poll to a terminal state
before trusting a probe).

**Trigger surface:** any quota-driven cleanup, GC pass, or manual reclaim of
provider-side sandbox artifacts in a shared org.

**Incident:** dev builds failed with a snapshot quota error while most
snapshot namespaces sat outside the GC's managed prefixes or below its
idle-time floor. A manual reclaim of 62 snapshots, chosen by "not referenced
in dev's own DB," changed the active count but did not fix the quota — the
next build failed identically, proving the count acted on was not the
dimension the provider actually metered. 56 of the destroyed snapshots were
`kortix-app-` images belonging to OTHER environments; their owner was
unverifiable from dev, and app rollback to those versions started 503ing
(rollback has no rebuild fallback; recovery required a redeploy from stored
artifact metadata).

**Enforcement:** none yet — a GC that can see and correctly attribute every
artifact namespace across all owning environments, and an assertion of the
provider's real metered dimension (not a locally-inferred one), are the TODO.
