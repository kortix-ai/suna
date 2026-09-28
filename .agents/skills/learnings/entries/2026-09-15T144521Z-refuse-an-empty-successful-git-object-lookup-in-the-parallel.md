---
recorded: 2026-09-15T14:45:21Z
incident_date: 2026-09-15
commit: 82dd96e754
---
# Refuse an empty successful Git object lookup in the parallel package gate

**When:** comparing a Git SHA captured by Bun `execFileSync` under parallel tests. A successful `git rev-parse` must print an object ID; retry an empty capture before using it as the expected SHA. *Near-miss:* two v0.13.15 local full runs compared a valid bundle SHA against `""` after `rev-parse HEAD` returned empty under load. *Enforcer:* the `git()` helper in `fast-boot-bundle.test.ts` retries and then fails explicitly.
