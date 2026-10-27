---
recorded: 2026-10-23T13:32:09Z
incident_date: 2026-10-23
---
# Recheck response-share migration order after merging dev

**Rule:** Re-date unmerged response-share migrations after the newest migration on dev after every trunk merge. Keep their SQL unchanged.

**Trigger surface:** Preparing a response-sharing branch for merge after updating it from dev.

**Incident:** PR #10816 had two pending migrations older than a migration already on dev. The migration sequence check rejected both before merge. Leaving them unchanged would stop the dev deployment.

**Enforcement:** `pnpm --filter @kortix/db lint` rejects pending migrations that predate dev's newest migration. Both renamed migrations pass this check.
