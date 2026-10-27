---
recorded: 2026-10-27T15:22:18Z
incident_date: 2026-10-27
---
# Reject normalized root paths before single-file Git reads

**Rule:** Check that `normalizeTreePath` produces a file path before single-file Git operations. A non-empty query can still name the repository root.

**Trigger surface:** Project file content, raw bytes, and history HTTP routes.

**Incident:** 2026-10-27, KRTX-3551: root aliases passed the route's string check and threw `File path is required` in dev (18 occurrences).

**Enforcement:** `apps/api/src/projects/routes/project-files-directory-pages.test.ts` sends `.`, `./`, and `.///` through the real handlers and requires 400, not 500. Valid relative reads still return their bytes/content.
