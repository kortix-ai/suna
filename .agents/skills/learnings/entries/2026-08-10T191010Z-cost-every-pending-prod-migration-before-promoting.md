---
recorded: 2026-08-10T19:10:10Z
incident_date: 2026-08-10
commit: 4833d30838
---
# Cost every pending prod migration before promoting

**When:** preparing a release/promote.
Ordering-correct is not enough. Diff `kortix_migrations.pgmigrations` on prod
against the promoted tree, and for each pending migration ask what it does at
prod data volume. A tag tree containing a migration file is NOT proof the
migration ran — only the ledger is.
*Incident:* same v0.12.7 outage — the dangerous migration had been "shipped" in
v0.12.6's tag but never applied; nobody costed it before the promote.
*Enforcer:* kortix-release skill Step 3.6 (checklist); this rule is the reason.
