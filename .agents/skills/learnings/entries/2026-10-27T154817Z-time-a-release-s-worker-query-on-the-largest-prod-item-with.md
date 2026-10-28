---
recorded: 2026-10-27T15:48:17Z
incident_date: 2026-10-27
---
# Time a release's worker query on the largest prod item with every output column consumed; a per-row search in SQL scans only the candidates its reader uses

**Rule:** Before a Promote, run each new worker query read-only on prod's largest items (most rows and most bytes), and make the timing select consume every output column (`sum(length(col::text))`), because Postgres drops subquery columns that `count(*)` does not read. A per-row search in SQL (`strpos`, `LIKE`, `= ANY`) runs only over the candidates the reader of its output uses. A cross product of every row with every id grows with rows × ids.

**Trigger surface:** Planning a promote; writing or reviewing SQL that a background worker runs per session, message or log row.

**Incident:** 2026-10-27, release v0.14.9 pre-Promote check, no user impact. The #10928 mirror-merge skeleton ran `strpos` over every tool state for every runtime session id. On prod, a 182 MB mirror with 479 runtime sessions, one of the 3 sessions the merge pass must finish, ran past its 2 min timeout, so every ~2 h pass would fail on it again. A first timing with `count(*)` read 59 ms and was false. `fromV1` reads the substring fallback only for ids no call names by `state.metadata.sessionId`. Searching only those ids took the same session to 3.3 s. Fix in PR #10957.

**Enforcement:** `apps/api/src/__tests__/integration-session-log-merge.test.ts` covers the exact-spawner and substring paths; dropping the clause that keeps exact spawners fails 2 cases. None yet for prod timing: a pre-Promote step that lists new worker-reached queries and requires a prod timing for each in the release notes.
