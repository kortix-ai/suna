---
recorded: 2026-11-02T18:54:02Z
incident_date: 2026-11-02
---
# Run the in-place recovery gate before condemning stuck provisioning runtimes

**Rule:** Reuse `recoverRemovedParkedRuntime` before preserving a stuck provisioning runtime as lost. A `removed` status read also covers recoverable Platinum failed starts and backed-up identities. Preserve the row returned by the recovery claim, not the original snapshot.

**Trigger surface:** Stuck-provisioning convergence after the restart or recovery owner lease expires.

**Incident:** KRTX-3921: five prod `provisioning_runtime_removed` reports arrived in one maintenance pass. The convergence path bypassed the recovery gate already used by parked-runtime verification and wake maintenance. The reports alone did not prove permanent data loss.

**Enforcement:** `apps/api/src/projects/reaping/stuck-provisioning-recovery.test.ts` exercises the real convergence function with collaborator boundaries. Recoverable and concurrently claimed identities must not be preserved; an unavailable identity must use the claimed row. All three tests fail before the fix.
