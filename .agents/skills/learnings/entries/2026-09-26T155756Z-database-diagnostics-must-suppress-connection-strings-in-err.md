---
recorded: 2026-09-26T15:57:56Z
incident_date: 2026-09-10
---
# Database diagnostics must suppress connection strings in errors

**Rule:** parse a PostgreSQL connection URL into separate `PGHOST`, `PGPORT`,
`PGUSER`, `PGPASSWORD`, and `PGDATABASE` environment variables before invoking
`psql` or any client that treats a raw value differently than intended. Keep
the password in memory, never on a command line or in a plain env dump.
Capture connection errors and report a sanitized failure, never the raw
driver error or the connection URL itself.

**Trigger surface:** any ad hoc database diagnostic, especially one run
against a release or production target during an incident.

**Incident:** a release diagnostic put a full PostgreSQL URL in `PGDATABASE`.
The installed `psql` treated it as a database name and printed a truncated,
credential-bearing URL into the local tool transcript. No public test
artifact received this output. Same class as "Verification output is an
exfiltration surface" (2026-08-28) — this is the database-connection-specific
instance of it.

**Enforcement:** none automated. The corrected diagnostic parses the
encrypted profile in memory, captures both output streams, and suppresses
connection details on failure — a procedure requirement for ad hoc
diagnostics, not an enforced gate.
