---
recorded: 2026-08-29T14:06:12Z
incident_date: 2026-08-29
commit: 1d6e43c051
---
# `docker image prune --filter until=24h` reclaims nothing on an environment that redeploys daily

**When:** adding disk housekeeping to any long-lived, frequently-redeployed box.
The persistent branch environment pulls ~3GB of images per deploy and never
reclaimed them; it hit 100% and the stack stopped coming up. The first fix used
`until=24h` to "keep today's generation as a rollback" — it reclaimed **0 B**,
because that box deploys several times a day so every superseded image is
younger than a day. Unfiltered (`docker image prune -af`) the same box went
90% -> 46%, 20.35 GB, with all 12 services still running: a running container
holds a reference to its own image, so only genuinely dead layers go.
**The rule:** prune AFTER the new stack passes its health check, with no age
filter, never fatal (`|| true`) — and verify the reclaim on the real box, because
a prune that frees nothing looks exactly like a prune that works.
*Enforcer:* `tests/unit/sandbox-preview.test.ts`.
