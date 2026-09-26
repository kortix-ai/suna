---
recorded: 2026-08-27T02:34:54Z
commit: 39685da48d
---
# A mocked-db unit test is not a real INSERT: a raw `sql` Date binding 500'd every real write

- **Incident (2026-08-27, WS-Z4 assembly of the Kortix Runtime API):** the daemon's runtime-projection push (`POST /v1/platform/runtime-projection`) 500'd on EVERY real request. `saveRuntimeProjection`'s out-of-order guard was `sql`${col} <= ${input.capturedAt}`` — a raw `sql` fragment binding a JS `Date`. postgres-js serializes a Date inside a raw fragment with its locale `toString()` ("Thu Aug 27 2026 03:01:29 GMT+0200 (CEST)"), which Postgres cannot parse as a timestamp. The `.values()`/`set` column bindings map a Date fine; only the raw fragment broke. The route's unit test mocked `db` wholesale, so the SQL never ran — the bug was invisible until a real daemon pushed to a real Postgres.
- **Rule:** inside a raw `sql`…`` fragment, never bind a JS `Date` for a timestamp column — bind `date.toISOString()` with an explicit `::timestamptz` cast. And a handler whose only test mocks the database has ZERO coverage of the SQL it emits: pin any raw `sql` fragment by compiling it (`new PgDialect().sqlToQuery(frag)`) and asserting the params are strings, not Dates — or exercise it against a real DB.
- **Enforcement:** `capturedAtNotNewerThan()` in `apps/api/src/projects/lib/session-runtime-projection.ts` is the extracted fragment; `session-runtime-projection.test.ts` compiles it and asserts the bound param is the ISO string + `::timestamptz`, never a Date. Verified live on a Platinum box: the push went 500 → `200 {"stored":"stored"}`.
