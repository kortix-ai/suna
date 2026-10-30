---
recorded: 2026-10-29T23:35:26Z
incident_date: 2026-10-29
---
# Run fixture cleanup tests with the existing Vitest runner

**Rule:** Run tests under `tests/unit` with the existing Vitest configuration.
Use its `vitest` imports. A successful direct Bun invocation does not verify this lane.

**Trigger surface:** Adding or verifying a fixture cleanup regression in `tests/unit`.

**Incident:** On 2026-10-29, the Artifact cleanup regression passed when run directly with Bun.
CI rejected its `bun:test` import before executing the test. The assertions were unchanged;
switching to the suite's runner made the actual configured test pass. No runtime code changed.

**Enforcement:** `pnpm --filter @kortix/tests test:unit resource-stack-cleanup.test.ts` passes.
The `flow-runner-unit` lane uses the same Vitest configuration and rejects incompatible imports.
