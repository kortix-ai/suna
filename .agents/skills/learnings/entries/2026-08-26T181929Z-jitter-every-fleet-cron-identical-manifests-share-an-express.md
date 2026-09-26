---
recorded: 2026-08-26T18:19:29Z
incident_date: 2026-08-26
commit: 82235c6856
---
# Jitter every fleet cron; identical manifests share an expression

**When:** scheduling any cron a project starter, template, or marketplace clone
ships. Every project that copied the manifest inherits the same expression and
fires on the same millisecond. Offset each trigger deterministically by
`(project_id, slug)` — deterministic because the catalog writes `next_fire_at`
and the claim sweep recomputes it, and a random offset makes them disagree.
*Incident:* 756 projects inherited `0 0 3 * * *`; the 03:00 hour took 779
provisions and failed 654 (346 `capacity`) while every other hour that day ran
100% healthy at 6-28 provisions. *Enforcer:*
`apps/api/src/projects/trigger-schedule.jitter.test.ts` asserts 766 keys spread
across the window instead of stacking.
