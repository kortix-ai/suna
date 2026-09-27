---
recorded: 2026-08-24T01:00:28Z
incident_date: 2026-08-24
commit: 69499ff723
---
# A successful surface deploy must not inherit skipped unrelated ancestors

**When:** chaining Dev deployment, canonical verification, and self-host channel
promotion jobs. Add `always()` and assert the direct prerequisite result for
each post-deploy job. A normal `if:` can inherit a skipped transitive ancestor,
skip verification, and leave the mutable self-host tag on an older image even
after the immutable image deployed successfully.
*Incident:* a Dev frontend deployed a transcript fix, but its DNS verification
and `:dev` promotion skipped. Self-host frontends kept a stale blank transcript.
*Enforcer:* `tests/unit/web-ecs-workflow.test.ts` pins the post-deploy conditions.
