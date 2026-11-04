---
recorded: 2026-10-28T15:45:29Z
incident_date: 2026-10-26
---
# A periodic sweep over every project proves an item changed with one cheap check before it pulls data; never force a refresh per item

**Rule:** A background loop that visits every project must not invalidate a cache or force a fetch per item. Ask for the cheapest proof of change first (one `git ls-remote` of the ref it reads) and reuse the last result while the proof is unchanged. Size any per-replica cache against the whole working set, or the loop clones what the cache just evicted.

**Trigger surface:** writing or changing a leader sweep, reconcile backstop or poller that iterates `projects` (connector sweep, trigger catalog, discovery batches), or any caller of `invalidateProjectMirror` / `refreshMirror(project, true)` inside a loop.

**Incident:** found 2026-10-27 from the AWS bill. The leader's connector sweep invalidated each project's mirror before reading `kortix.yaml`. With 8,666 active projects and a 4 GiB mirror cache, the cleanup deleted 114,397 mirrors (199.5 GB) on 2026-10-26, and prod pulled ~690 GB/day from GitHub through the NAT gateways (~$34/day, 73 % of prod NAT bytes). Each leader change (4 that day, from autoscaling) restarted the sweep in its back-to-back backfill mode. Fixed in PR #11036.

**Enforcement:** `apps/api/src/projects/manifest-reuse-at-tip.test.ts` fails when a sweep read re-clones an evicted mirror while the default branch is unchanged. None yet for other loops: a lint or test that flags `invalidateProjectMirror` inside a `mapWithConcurrency` over projects.
