---
recorded: 2026-10-02T11:45:24Z
incident_date: 2026-10-02
---
# Make the owner's delete release every provider artifact its create minted, on every provider

**Rule:** when a create path mints a provider-side artifact (image, template,
snapshot, volume), the owner's delete path releases it in the same request,
and a sweep retries what the request could not finish. Key the sweep on THIS
environment's database rows (the owner is gone or the artifact can never
serve), never on name age alone — see the 2026-09-26 shared-org entry. A
reaper written for one provider is not a reaper for the artifact: when a
provider is added, list every artifact prefix the platform mints and confirm
each has a reclaim path on that provider. Report what stayed behind
(`pending`) instead of swallowing it.

**Trigger surface:** adding a provider build/create call, adding a delete
route for anything that owns one, adding a sandbox provider, or writing a
quota GC.

**Incident:** every App deploy (and every automatic runtime rebuild) minted a
`kortix-app-<deploymentId>` template. `DELETE /apps/:id` removed runtimes only.
Quota GC learned the `kortix-app-` prefix on 2026-09-27, for Daytona only;
Platinum, whose per-org template count is capped (`org_template_quota_exceeded`,
tiers 10/50/500), had no reclaim path at all. Customer orgs filled the cap and
had no CLI or API way to free it; deleting the App did not help. Fixed on
branch `apps-template-reclaim`: App delete and the new
`DELETE /apps/:id/deployments/:did` release images; project maintenance sweeps
the rest per configured provider.

**Enforcement:** `apps/api/src/services/apps/images.test.ts` (foreign ids untouched,
unreadable DB deletes nothing, per-pass cap, pinned image is `pending`),
`apps/api/src/services/apps/images.integration.test.ts` (the sweep's SQL on real
PostgreSQL), flow `APP-7`, and the `app_images_*` maintenance heartbeat
counters. Not enforced: a check that every artifact prefix has a reclaim path
on every enabled provider — that lint is the TODO.
