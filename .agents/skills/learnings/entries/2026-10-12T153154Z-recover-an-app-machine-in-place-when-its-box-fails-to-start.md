---
recorded: 2026-10-12T15:31:54Z
incident_date: 2026-10-11
---
# Recover an App machine in place when its box fails to start; a wake that only polls shows Starting forever

**Rule:** When an App wake finds its box `removed` or `terminal` at the provider, call the provider's `recoverInPlace` once (Platinum: start again, or restore the box's backup, same id) before failing the wake. Every provider status the wake treats as final must have a recovery attempt or a terminal page; a wake that throws and lets the next request retry shows "Starting" forever.

**Trigger surface:** Changing the App wake path (`apps/hosting.ts` `waitForProviderRunning`, `apps/public-proxy-runtime.ts` `ensureAppRuntimeRunning`), or adding a provider state mapping in `platform/providers/*.ts` `getStatus`.

**Incident:** 2026-10-11 to 2026-10-12, a self-hosted instance on v0.13.52. A Platinum App box went to `failed-start` after an idle stop (Platinum keeps the disk; `/start` succeeds). `getStatus` maps `failed-start` to `removed`; `ensureRunning` only starts a `stopped` box, and the wake threw on `removed`. The public App answered `202 Starting` on every request for about 31 hours, with no error in the API log. A manual `POST /v1/sandboxes/<id>/start` brought it back (`200` in 9.8 s). v0.13.56 had the same wake path.

**Enforcement:** `apps/api/src/apps/hosting.test.ts`: "a box whose start failed is recovered in place once, then wakes" and "a box that cannot be recovered in place fails the wake".
