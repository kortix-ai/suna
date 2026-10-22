---
recorded: 2026-10-13T19:53:57Z
incident_date: 2026-10-13
---
# When a fix stops new stale rows, close the old ones before a new surface reads them

**Rule:** A fix that keeps a stored state truthful from now on leaves every row an older bug wrote. Before a new surface (a list status, a badge, a filter) reads that state, measure the stale rows read-only on dev, staging and prod, then close the ones the new rules prove stale in a batched `.concurrent.ts` pass that ships with the change. List the rows no rule can classify, with counts, as a decision before the promote.

**Trigger surface:** Fixing when a stored row closes or expires (`session_pending_questions.answered_at`, a turn ledger state, an approval status), and in the same change rendering that row in a new place.

**Incident:** 2026-10-13, dev, near-miss (#9772, KRTX-1739). #9772 closed a stored agent question when its wait ended and showed every open question as Needs you in the web and mobile session lists. Rows from before the fix stayed open: dev held 75 open questions, 59 older than 7 days; prod held 1,093, and 518 were stale by the new rules. Caught on dev before a promote. The follow-up backfill `20261013195005605_pending_questions_close_stale.concurrent.ts` closes the 518; 575 prod rows (an abandoned or unknown turn end, or no turn row) need a product rule for when a question expires.

**Enforcement:** `packages/db/scripts/pending-questions-close-stale.integration.test.ts` (the backfill closes exactly the rows the new rules close and is idempotent). For the general rule, none yet: a review checklist item in the migration skill ("does this change render stored state that older rows hold wrongly?").
