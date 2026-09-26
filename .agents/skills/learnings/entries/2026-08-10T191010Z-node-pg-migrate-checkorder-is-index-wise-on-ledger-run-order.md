---
recorded: 2026-08-10T19:10:10Z
incident_date: 2026-08-10
commit: 4833d30838
---
# node-pg-migrate checkOrder is index-wise on ledger run order

**When:** doing any out-of-band migration apply or ledger surgery.
`checkOrder` compares the ledger's run order (`ORDER BY run_on, id`) position by
position against filename order — appending an older-named migration to the end
of the ledger fails the NEXT migrate even though "everything is applied". Place
reconciled rows' `run_on` so ledger order matches file order.
*Incident:* staging deploy failed post-reconcile until the 7 audit-v2 rows were
re-timestamped before the two later migrations.
