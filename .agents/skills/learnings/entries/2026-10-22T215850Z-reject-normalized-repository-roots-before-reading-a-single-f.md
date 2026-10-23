---
recorded: 2026-10-22T21:58:50Z
incident_date: 2026-10-22
---
# Reject normalized repository roots before reading a single file

**Rule:** Use normalizeTreePath after rejecting absolute and traversal paths; reject an empty result before a single-file read.

**Trigger surface:** Project file content and raw-byte HTTP reads.

**Incident:** 2026-10-22, KRTX-3174: root aliases passed the raw path check and threw File path is required, returning 500 on both routes.

**Enforcement:** apps/api/src/projects/routes/project-files-directory-pages.test.ts drives both HTTP handlers with dot-root aliases.
