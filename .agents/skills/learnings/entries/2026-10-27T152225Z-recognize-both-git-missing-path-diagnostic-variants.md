---
recorded: 2026-10-27T15:22:25Z
incident_date: 2026-10-27
---
# Recognize both Git missing-path diagnostic variants

**Rule:** Treat both Git missing-path messages as expected file-not-found outcomes, not server errors.

**Trigger surface:** Reading a file at a Git ref through a local mirror.

**Incident:** On 2026-10-27, API dev reported six GitOperationError occurrences (KRTX-3552). Git emitted `exists on disk, but not in` instead of `does not exist in` when the missing committed path existed locally.

**Enforcement:** `apps/api/src/projects/git/missing-path.test.ts` runs real Git and verifies both diagnostic variants and typed string/binary reader failures. Invalid refs remain failures.
