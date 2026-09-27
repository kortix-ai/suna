---
recorded: 2026-08-10T19:47:45Z
incident_date: 2026-08-10
commit: 427fc1a175
---
# An audit reconstruction trigger is only safe with its dedup index

**When:** installing triggers that INSERT INTO audit_events with
source_ledger/source_record_id set. The prepare-trigger's duplicate check needs
`idx_audit_events_source_phase`; without it every triggered insert seq-scans
the whole table and times out the OUTER statement — cron trigger dispatch
failed prod-wide for ~80 min. Order in any reconcile: dedup index BEFORE (or
immediately after) trigger install, never "later with the other indexes."
*Incident:* v0.12.7 reconcile installed triggers at 17:56, index landed 19:29.
