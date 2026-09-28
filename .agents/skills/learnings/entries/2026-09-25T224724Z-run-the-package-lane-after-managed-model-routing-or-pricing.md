---
recorded: 2026-09-25T22:47:24Z
incident_date: 2026-09-26
---
# Run the package lane after managed model routing or pricing changes

**Rule:** Run `pnpm test -- --packages-only` when managed model routing or
pricing changes. Keep the sandbox daemon's baked fallback catalog prices in
sync. Test minimal config mocks that omit new optional operator settings.

**Trigger surface:** Managed model descriptors, prices, or operator settings.

**Incident:** On 2026-09-26, a draft PR passed focused gateway tests but the
package lane found stale baked prices and a mock config crash before merge.

**Enforcement:** `opencode-catalog.test.ts` compares the baked daemon catalog
with the managed lineup. `commands-panel.test.ts` exercises a minimal config.
The `packages` CI lane runs both tests.
