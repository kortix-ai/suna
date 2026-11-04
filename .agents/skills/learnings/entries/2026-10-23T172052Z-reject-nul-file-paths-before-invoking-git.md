---
recorded: 2026-10-23T17:20:52Z
incident_date: 2026-10-23
---
# Reject NUL file paths before invoking Git

**Rule:** Reject NUL-containing file paths at the HTTP boundary. Do not strip NUL: that selects a different file. Use the existing impossible-path 404 response.

**Trigger surface:** Project file content, raw bytes and history reads backed by Git.

**Incident:** On 2026-10-23, KRTX-3404 recorded seven API failures. A NUL path reached child_process as a Git object argument and raised GitOperationError instead of a client response.

**Enforcement:** `apps/api/src/projects/routes/project-files-directory-pages.test.ts` tests NUL-only, leading, embedded and trailing NUL on all three read routes. `tests/src/flows/files.flow.ts` FILE-2 covers the authenticated content route.
