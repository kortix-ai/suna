---
recorded: 2026-10-30T00:14:20Z
incident_date: 2026-10-30
---
# Capture owned Files volume identities before fixture teardown and prove provider deletion

**Rule:** Capture each synthetic project's Files volume identity before publishing. Delete that exact volume in `finally` and verify provider GET returns 404 before database fixture teardown removes its drive row. Database cascades do not delete provider storage.

**Trigger surface:** API flows that publish actual Files content on database-only projects.

**Incident:** During PR #11110 follow-up HTML bridge verification, ART-1 passed while its database-only fixture cleanup erased the drive mapping and retained three newly created Files volumes. Exact run-specific synthetic paths identified all three. Scoped deletion and provider404 read-back completed for all three; unrelated volumes remained untouched.

**Enforcement:** ART-1 captures `GET /drives?projectId=` before publish, deletes its derived volume in `finally`, and asserts DELETE204 then GET404. ART-6 and ART-9 retain the same explicit provider cleanup contract.
