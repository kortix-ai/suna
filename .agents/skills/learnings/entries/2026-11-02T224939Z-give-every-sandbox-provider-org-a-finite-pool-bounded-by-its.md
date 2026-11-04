---
recorded: 2026-11-02T22:49:39Z
incident_date: 2026-11-02
---
# Give every sandbox-provider org a finite pool bounded by its share of the region

**Rule:** No org on the sandbox provider (Platinum) may have an unlimited compute pool, internal orgs included. Every org's pool is finite, and no org may hold more than `limits.org_max_fleet_share_pct` (default 40%) of a region, whatever its tier says. Size new tiers on the Platinum admin Capacity page against the hosts that exist, and buy hosts when the plan says so.

**Trigger surface:** Assigning a Platinum tier or override to an org (`PATCH /internal/admin/org-overrides/:org`, `PUT /internal/admin/config/limits.tiers`), starting a high-volume workload (CI runners, load tests) on Platinum, or reading a "Sandbox capacity is full" failure in Kortix.

**Incident:** 2026-11-02, 17:51–21:40 UTC. An internal CI org on Platinum resolved to an aggregate pool of `0` (unlimited). With `pool_fallback: any` it spilled from its dedicated host onto the shared eu-west fleet: 109 sandboxes, 1312 GB RAM. The fleet's 7-day peak (2801 GB) passed what it can place (~2780 GB). Every 12288 MB / 6 vCPU create of Kortix's own company project got `503 no capacity on a host that can mount these volumes`: 40 refusals, 28 agent-spawned sessions, 26 left `failed` with "Sandbox capacity is full". Smaller 4096 MB sessions still fit, so only one project saw it. Mitigation at 21:51 UTC: the CI org was capped at 1 TB / 384 vCPU. Kortix's failure card also hid the saved prompt of agent-created sessions; fixed in #11524. Kortix's `/start` retried 6× with 5–60 s backoff and lost every race to the CI org's own retry storm (2351 refusals in one hour).

**Enforcement:** Platinum `kortix-ai/platinum#2531`:
- `orgPoolLimits` never returns an unlimited pool. `apps/api/src/spawnLockSkip.test.ts` and `orgSpecLimits.caps.test.ts` go red if any tier resolves to 0.
- The write paths refuse a 0 pool (400).
- `apps/api/src/orgPool.ts` enforces min(pool, region share) on create, start, resume, resize, clone and fork for every role. `sandboxes.pool-cap.int.test.ts` covers each path for an org key and an admin.
- alert-cron raises `capacity_buy` / `capacity_critical` from the capacity plan.
