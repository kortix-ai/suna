---
recorded: 2026-11-02T21:04:56Z
incident_date: 2026-11-02
---
# Pin heartbeat fixtures before testing UTC day deferral

**Rule:** Set a heartbeat fixture before the next UTC midnight when testing its replacement at the wake cap. A relative four-hour reminder can already fall tomorrow; production correctly preserves that later reminder.

**Trigger surface:** CLI goal wake-cap tests using a fake reminder API and the real CLI subprocess.

**Incident:** 2026-11-02, v0.14.16 candidate, release run 41515797210 failed the CLI lane after 20:00 UTC. The fixture returned now plus four hours, so the assertion expected replacement of a reminder already beyond midnight.

**Enforcement:** `apps/cli/src/commands/goals.test.ts` pins the existing heartbeat before the second wake. The real CLI must still replace it with a midnight reminder, persist the same timestamp, and record the wake cap.
