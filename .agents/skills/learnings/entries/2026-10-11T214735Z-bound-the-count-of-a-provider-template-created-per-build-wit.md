---
recorded: 2026-10-11T21:47:35Z
incident_date: 2026-10-11
---
# Bound the count of a provider template created per build with a periodic reaper and a quota alarm, not only a predecessor prune

**Rule:** A provider-side artifact created per build needs a bounded-count or bounded-age
reaper, not only a predecessor prune. A periodic worker keeps the N newest ready templates
per namespace plus every template a sandbox or project still pins, and deletes the rest. An
alarm fires when the org's template count passes a fraction of the quota (for example 70%).
The predecessor prune (`apps/api/src/snapshots/builder.ts` ~446-464) deletes only the
immediate predecessor of a new build, and keeps it inside `PREDECESSOR_PRUNE_PROTECT_MS`
(6 h, `builder-log.ts`). A kept predecessor is never revisited, and failed builds and dead
chains leave templates behind for ever. Same class as
`2026-08-13T075428Z-anything-created-per-deploy-needs-a-reaper-and-the-reaper-ne.md`
(Daytona snapshot quota): that entry covers the reaper and its namespace, this one the bound.

**Trigger surface:** a deploy that changes `KORTIXD_SHARED_SOURCES` files (new daemon
fingerprint, new template), a project template build, a warm-pool image, or an edit to
`apps/api/src/snapshots/predecessor-reap-policy.ts`. Symptom: every new session fails with
"The sandbox provider could not start this session. Try again." while the provider `/health`
is green. Sessions whose daemon build already has a template keep starting, which hides the
cause. The cause is in `metadata.provisioningError` of the failed `kortix.session_sandboxes`
rows.

**Incident:** 2026-10-11, dev. From 19:54Z to about 21:30Z every new session on dev failed,
on both harnesses, in several projects (last good start 19:46Z, last failed start seen 20:47Z). `platinum POST
/v1/templates/from-build` returned `429 org_template_quota_exceeded` (`used` 1324, `quota`
1000); `failureCategory: sandbox-provider`, `initAttempts: 3`. Dev and staging share one
Platinum org (same `PLATINUM_API_KEY` in `apps/api/.env`, `.env.dev`, `.env.staging`; prod
uses another key). `GET /v1/templates` returned 50 items for every `page`, `limit`, `offset`
and `cursor` tried, so the API could not list the inventory. The dev table
`kortix.project_snapshot_builds` held 1320 rows (901 ready, 409 failed, 10 building). Ready
rows older than 30 days: `kortix-ppwarm-*` 538 of 538, `kortix-default-*` 146 of 206,
`kortix-tpl-*` 126 of 157. Seven daemon-affecting PRs merged that day, so many predecessors
sat inside the 6 h window. The quota cleared between 20:48Z and about 21:30Z when an operator
deleted 997 templates by hand (262 failed builds, 736 superseded `kortix-default-*`; the org
went from 1,645 to 646), as `2026-10-11T211903Z-watch-the-platinum-template-count-per-org-kortix-reclaims-on.md`
records. The incident session deleted nothing. Starts worked again from about 21:30Z; a probe at 21:44Z confirmed it.

**Enforcement:** none yet. To build: a periodic template reaper in `apps/api/src/workers/`
with bounded retention per namespace (N newest ready plus pinned) that also removes failed
and dead-chain templates, and a template-count metric with an alarm at a fraction of the
quota. The entry above names a Platinum branch of the snapshot-quota GC in
`projects/maintenance.ts` as the same follow-up: build one reaper, not two. Until then, an operator deletes old `kortix-ppwarm-*`, `kortix-default-*` and
`kortix-tpl-*` templates by hand when the symptom appears.
