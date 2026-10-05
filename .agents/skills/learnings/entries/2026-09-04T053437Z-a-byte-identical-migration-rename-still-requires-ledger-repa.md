---
recorded: 2026-09-04T05:34:37Z
incident_date: 2026-09-04
commit: acd6bcce90
---
# A byte-identical migration rename still requires ledger repair

**When:** changing any applied migration filename, including a timestamp-only rebase.
**Incident:** the `pi-worker` full local gate re-ran `secret_consumer_boundary` under its new
name and failed on duplicate enum `42710`; the database recorded the byte-identical old name.
**Rule:** add every old-to-new filename pair to the checksum-guarded repair and normalize the
whole affected ledger suffix by database microsecond order. File-content equality is not identity.
**Enforcer:** unit and PostgreSQL integration tests cover the secret-consumer rename and strict order.
