---
recorded: 2026-11-04T00:27:24Z
incident_date: 2026-11-04
---
# Never let internal agent workloads share the pool of the provider org that serves customers

**Rule:** The Platinum org that serves Kortix customer sessions holds customer sessions only. Run internal agent fleets (the company factory, cron workers, CI) in their own Platinum org with their own finite pool. When you change one org's pool, keep the sum of every org's pool at or below the region's supply. Read it on the Platinum admin capacity plan (`committed` vs `supply`).

**Trigger surface:** Starting or scaling an internal agent fleet on the customer-serving Kortix project or org, raising a worker's sandbox shape, changing `limits.org_max_fleet_share_pct` or an org's `maxTotal*`, or reading a "Sandbox capacity is full" failure in Kortix.

**Incident:** 2026-11-04, ~00:02 UTC. The Kortix customer-serving org reached its own pool: 480 vCPU, the 40% region share from the 2026-11-02 entry. Platinum answered `429 pool_exceeded` (`cap 480, used 480, resource cpu`). Kortix showed it as "Sandbox capacity is full". One internal project held 71 of the org's 100 running boxes and 414 of its 480 vCPU: about 60 agent-spawned workers and 9 cron workers at 6 vCPU / 12 GB each, nearly all mid-turn. In the preceding 30 h, 39 sessions hit a `capacity` failure and 33 stayed `failed`. A customer session opened only on its 4th attempt. Mitigation at ~00:25 UTC: share 40% → 55%. The customer org went to 704 vCPU / 1408 GB. The internal CI org went to 160 vCPU / 480 GB, internal dev to 224 vCPU / 512 GB, one internal workspace to 32 vCPU / 96 GB. The sum of pools fell from 2062 vCPU / 3858 GB to 1262 vCPU / 2770 GB, against a supply of 1280 vCPU / 2778 GB. One idle orphan box (16 vCPU, idle 5 days) was stopped.

**Enforcement:** none yet. Build: (1) move the internal company project to its own Platinum org; (2) make the capacity planner raise a warning, not info, when the customer-serving org reaches its cap, and when `committed` exceeds `supply`; (3) make Kortix `/start` retry `pool_exceeded` and show its own message.
