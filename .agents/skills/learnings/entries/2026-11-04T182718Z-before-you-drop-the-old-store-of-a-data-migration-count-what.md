---
recorded: 2026-11-04T18:27:18Z
incident_date: 2026-11-04
---
# Before you drop the old store of a data migration, count what the new store must hold, not only what the old store held

**Rule:** A migration is complete when every record the product promises to keep is in the new store. Before you delete the old store or the reader of the last copy, count the source population (here: sessions with a turn) against the new store. "Every row of the old table is converted" proves only that the old table held everything. It did not.

**Trigger surface:** Planning or approving the drop of an old table, a backfill's "done" state, or the deletion of the code that reads a copy of the data (a harness adapter, a provider reader).

**Incident:** 2026-11-04, prod. The session-log backfill (`mirror_sessions_without_log`) and the B3 drop guard covered only sessions with rows in the old transcript mirror. The mirror was an off-by-default flag until 2026-09-28 and skipped agent-spawned sessions until #8177. About 7,600 prod sessions with turns (Jun – Oct 11; 1,544 Platinum, 6,069 Daytona) had no session log. Their history lived only in `opencode.db` on archived boxes, and #11155 deleted the last reader. Users saw an empty session, or a lost-computer card with only Delete. Recovery: `apps/api/src/scripts/recover-opencode-history.ts` (PR description has the numbers).

**Enforcement:** none yet. The enforcer to build: a drop guard that counts the source population, not the old table. Here that is sessions with a turn and no session log (`recover-opencode-history.ts --plan` prints it).
