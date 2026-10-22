---
recorded: 2026-09-30T19:41:26Z
incident_date: 2026-09-30
---
# Deliver a managed-model field change through the daemon or the live listing, never only through the image's baked catalog

**Rule:** A change to a managed model's runtime fields (`limit`, modalities, reasoning options) must reach a freshly booted OpenCode without a new sandbox image. The snapshot builder swaps a new daemon into the previous image when only the agent binary changed. Neither template fingerprint covers `/opt/kortix/llm-catalog.json`, so that file keeps the lineup of the last full build. At boot the daemon has no live listing yet. It must take the field from its own bundled table (`fallback-models.ts`, kept equal to `MANAGED_MODELS` by `managed-fallback-sync.test.ts`), or the post-spawn reconcile must restart OpenCode on the difference. Verify on dev by reading `GET /v1/p/<external_id>/4096/config/providers` from a new session, not the API's `/v1/llm/models`.

**Trigger surface:** Changing `MANAGED_MODELS` in `packages/llm-catalog`, `withManagedOverlay` / `capabilityKey` in `harness/open-code/lifecycle.ts`, or the snapshot builder's swap path (`apps/api/src/snapshots/templates.ts` `swapKey`).

**Incident:** 2026-09-30, dev, a near-miss. PR #8490 lowered the managed `limit.context` to 1,000,000. The API served the new value, but two new dev sessions on new templates (`kortix-default-6f1e…`, `kortix-default-c8d4…`) booted OpenCode with 1,048,576. Their baked catalog dated from 18:23Z, before the merge. `withManagedOverlay` let the baked record win, and the reconcile compares ids and image/thinking capabilities only.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/opencode-catalog.test.ts` ("a baked managed record takes the bundled limit, and keeps every other field").
