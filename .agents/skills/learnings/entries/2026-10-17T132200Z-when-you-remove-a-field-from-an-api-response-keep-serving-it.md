---
recorded: 2026-10-17T13:22:00Z
incident_date: 2026-10-16
---
# When you remove a field from an API response, keep serving it while released clients still read it

**Rule:** Before you drop a field from an API response, grep every released CLI, SDK and app version for reads of it. If a released client gates on it, keep serving a compatible value (for a graduated flag: `true`) until those clients are unsupported.

**Trigger surface:** graduating or deleting a feature flag; renaming or removing a field in a serializer under `apps/api/src/**/serializers.ts` or `packages/api-contract`.

**Incident:** 2026-10-16/17, v0.14.0. #9934 graduated Apps and `GET /v1/projects/:id` stopped serializing `experimental.apps`. CLIs up to v0.13.57 pre-check that value, so every `kortix apps` command exited 1 with "Apps is not enabled for this project" on prod and on an updated self-host box. A self-host customer was blocked from deploying an App. Fixed by #10122 (serializer emits `apps: true`).

**Enforcement:** flow APP-1 asserts `$.experimental.apps === true`. none yet for the general case: a contract test that runs the previous released CLI binary against the release tree.
