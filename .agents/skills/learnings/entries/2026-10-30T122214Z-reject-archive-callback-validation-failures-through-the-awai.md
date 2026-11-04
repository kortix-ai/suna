---
recorded: 2026-10-30T12:22:14Z
incident_date: 2026-10-30
---
# Reject archive callback validation failures through the awaited promise

**Rule:** Do not throw from tar entry callbacks. Capture validation failures and reject after the parser completes, before extraction.

**Trigger surface:** Inspecting untrusted App source archives in apps/api/src/apps/artifacts.ts.

**Incident:** 2026-10-30, KRTX-3723: an absolute archive link caused an uncaught API exception instead of rejecting the deployment promise.

**Enforcement:** apps/api/src/apps/artifacts.test.ts creates real compressed archives with absolute and escaping links; extraction must reject and leave no output directory.
