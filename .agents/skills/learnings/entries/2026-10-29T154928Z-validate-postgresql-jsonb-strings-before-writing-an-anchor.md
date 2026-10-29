---
recorded: 2026-10-29T15:49:28Z
incident_date: 2026-10-29
---
# Validate PostgreSQL JSONB strings before writing an anchor

**Rule:** Reject NUL and lone UTF-16 surrogates before storing request strings in PostgreSQL JSONB. Return the endpoint validation error.

**Trigger surface:** Adding JSON selectors or other structured customer input backed by PostgreSQL JSONB.

**Incident:** 2026-10-29, KRTX-3661, caught before merge. An anchor schema accepted strings that PostgreSQL rejects, turning invalid anchors into HTTP 500.

**Enforcement:** `packages/shared/src/artifact-comments.test.ts` rejects invalid anchor strings. REST flow `ART-4` asserts HTTP 400 `invalid_anchor` for NUL input.
