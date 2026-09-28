---
recorded: 2026-09-18T07:52:43Z
incident_date: 2026-09-18
commit: acd98370db
---
# Preview completion belongs to one workflow attempt; daemons must release the deploy lock

**Rule:** give each preview workflow run and attempt its own exit file. Close
FD 9 before starting Docker so the daemon and its containers cannot retain the
deployment lock after bootstrap exits. **Near-miss:** PR #7381's redeploy read
its previous failure while waiting on a lock inherited by Docker and its shims;
the preview stayed on the previous SHA. Recover an affected preview only after
confirming no deployment owns the old lock. **Enforcer:**
`tests/unit/sandbox-preview.test.ts` pins result identity and daemon FD closure.
