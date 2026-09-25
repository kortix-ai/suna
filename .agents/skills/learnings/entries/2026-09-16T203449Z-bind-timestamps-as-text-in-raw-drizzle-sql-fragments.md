---
recorded: 2026-09-16T20:34:49Z
commit: 050124ccbc
---
# Bind timestamps as text in raw Drizzle SQL fragments

**Near-miss (2026-09-16, PR #7319):** the pooled key cooldown update passed
TypeScript and gateway unit tests. The first real PostgreSQL call failed
because the `postgres` driver received a JavaScript `Date` from a raw `sql`
fragment.

**Rule:** convert a timestamp to ISO text and cast it to `timestamptz` when
binding it inside raw Drizzle SQL. Exercise the database write with a real row
before claiming the API behavior works.

**Enforcement:** `coolDownAccountSecret` uses an ISO timestamp with an explicit
cast. The direct local PostgreSQL call completed after this change.
