---
recorded: 2026-10-05T23:04:11Z
incident_date: 2026-10-05
---
# Find the session-open enforcers in projects/session-open/ since R4 moved them

**Rule:** The rules of the three entries below are unchanged. Their enforcers moved, with no behavior change, from `apps/api/src/projects/routes/` to `apps/api/src/projects/session-open/`. Read the old paths in those entries as the new folder. `runOpenSession` moved from `projects/routes/shared.ts` to `projects/session-open/index.ts`.
- `2026-08-26T130600Z-a-stamped-failure-is-a-cooldown-never-a-gravestone-and-a-neg.md` → `projects/session-open/stopped-wake-result.test.ts`
- `2026-09-28T040940Z-admission-refusal-must-replace-the-runtime-never-route-throu.md` → `projects/session-open/replace-refused-runtime-on-open.test.ts`, `projects/session-open/preserve-established-runtime-on-open.test.ts`
- `2026-09-28T090254Z-converge-continuously-boot-time-only-logic-never-re-runs-on.md` → `projects/session-open/wake-repair-grace.test.ts`

**Trigger surface:** reading one of those entries, or editing the session-open path (`/start`, wake, readiness, recovery).

**Incident:** none. The R4 API-layers refactor (2026-10-05) moved the session-open family out of the route folder so no service imports a route module. The ledger is append-only, so this entry carries the new paths instead of editing the three entries.

**Enforcement:** the moved tests themselves, run by `pnpm test` (core lane).
