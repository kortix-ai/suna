---
recorded: 2026-08-10T19:10:10Z
incident_date: 2026-08-10
commit: 4833d30838
---
# Bot-pushed release PRs and repo Actions approval policy

**When:** a required check sits in `action_required`, or changing repo Actions
settings. `fork-pr-contributor-approval: all_external_contributors` holds EVERY
PR workflow whose actor lacks write access — including `github-actions[bot]` on
promote-created release PRs — stalling releases behind a manual approve click.
Keep it at `first_time_contributors` (org default) unless there is a concrete
reason, and never quietly stricter than the org.
*Incident:* v0.12.7 release gate stalled in `action_required`.
