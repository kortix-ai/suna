---
recorded: 2026-10-13T18:00:04Z
incident_date: 2026-10-13
---
# Switching a feature off hides it and stops writes; it never blocks reads of what sessions already wrote

**Rule:** When a feature flag turns off, hide the surface and refuse new writes. Keep every read by id open, so a file, link or card a session already produced still opens. Put a product flag on the project, like every other flag; never on an operator-only, organization-wide switch the project admin cannot see or change.

**Trigger surface:** Gating routes on a feature flag (`requireFeatureFlag`, a gate inside a shared loader such as `callerOn` in `apps/api/src/drives/routes.ts`); adding a flag whose value does not live in `projects.metadata.experimental`.

**Incident:** 2026-10-13, prod (v0.13.56, from #9592). Volumes and Stateless sessions were organization flags that only a platform operator could change; every project's Settings listed them as "Whole organization, managed by Kortix" with a locked switch. Clearing an organization's Volumes entry turned off Files for every project in it, and the drive routes refused every method, reads included: file cards under `/drives/...` in existing transcripts showed `Files is not enabled for this organization.` Fixed by making both per-project flags and gating only the Files list and writes.

**Enforcement:** `apps/api/src/__tests__/integration-drive-access-enforcement.test.ts` ("Volumes turned off for the project": a read by drive id answers the same with the flag on and off; writes and the Files list get 403 `feature_disabled`); flow `DRIVE-1` (same, over HTTP); `apps/api/src/__tests__/unit-feature-flags.test.ts` (every offered flag is `scope: project` and not operator-only).
