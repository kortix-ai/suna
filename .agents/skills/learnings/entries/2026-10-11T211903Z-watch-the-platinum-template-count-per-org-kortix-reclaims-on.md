---
recorded: 2026-10-11T21:19:03Z
incident_date: 2026-10-11
---
# Watch the Platinum template count per org; Kortix reclaims only App images there

**Rule:** When an image build on Platinum fails with `org_template_quota_exceeded`, prune the org's superseded templates (failed builds, and ready ones no sandbox pins that are older than 7 days and not the newest 3 of their name family). Platinum's `DELETE /v1/templates/:id` refuses a template any sandbox can still need (`templatePins.ts`), so the delete is guarded server side. Never assume a Kortix sweep keeps the count down: `reconcileSnapshotQuota` (projects/maintenance.ts) reclaims Daytona snapshots only, and `reclaimAppDeploymentImages` reclaims App images only. Platinum session images (`kortix-default-*`, `kortix-tpl-*`, `kortix-ppwarm-*`) are never reclaimed.

**Trigger surface:** A Dockerfile or bundle App deploy, a session template build, or a provider transition on dev or staging fails with `org_template_quota_exceeded`. Before a release, check the prod org's count too.

**Incident:** 2026-10-11. Dev and staging share one Platinum org. It held 1,645 templates against a cap of 1,000: 1,014 `kortix-default-*` session base images, 262 failed builds, and per-project, warm, CI and App images. Every image build on dev and staging failed; it surfaced as an App dashboard deploy that could not build. Deleting 262 failed builds and 736 superseded `kortix-default-*` images (997 deleted, 1 refused with 409 because a sandbox had pinned it) brought the org to 646. Prod's org held 289 the same day and only grows.

**Enforcement:** none yet. Build a Platinum branch of the snapshot-quota GC in `projects/maintenance.ts`: list the org's templates, keep the ones a live or stopped sandbox pins and the newest per family, and delete the rest past an age, pressure-gated like the Daytona GC.
