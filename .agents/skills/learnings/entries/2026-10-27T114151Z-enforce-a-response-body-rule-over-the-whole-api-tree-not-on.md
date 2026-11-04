---
recorded: 2026-10-27T11:41:51Z
incident_date: 2026-10-23
---
# Enforce a response-body rule over the whole API tree, not on the route that taught it

**Rule:** A route `catch` that puts the caught error's message in a response calls `rethrowDatabaseError(err)` (`apps/api/src/shared/database-errors.ts`) first, after its typed branches. The global handler then answers a generic 500 and logs the statement. When a database state is expected, map it before that call: a unique violation becomes a 409 with a `code` read from `uniqueViolationConstraint(err)`, never from the message text. Drizzle's message is `Failed query: <sql>\nparams: <values>`, so a match on "duplicate" never fires.

**Trigger surface:** Writing or reviewing a `try`/`catch` in `apps/api/src` that awaits anything and answers with `c.json`/`c.text`. Also: fixing a class-of-bug rule in one place. A rule whose enforcement covers one route does not hold for the next route.

**Incident:** 2026-10-23, a pentest finding against production. A duplicate sandbox-template slug (`POST /v1/projects/{id}/sandbox-templates`) answered 400 with the whole INSERT: the schema, 25 column names, and the bound project and account ids. The route matched "duplicate" in the message, which Drizzle's wrapper never contains. The 2026-09-26 entry ("Never return a raw database error message in an API response") already stated the rule. Its enforcement covered only `GET /v1/admin/analytics/usage`. An AST scan found 83 catch-all echoes in 32 route files, this route's 4 included. Local reproduction on `dev` code: 3 of 3 failure paths (duplicate slug, PATCH and POST with a NUL byte) returned 400 with the SQL.

**Enforcement:** `apps/api/src/__tests__/unit-catch-database-error-echo-guard.test.ts` reads every API source file with the TypeScript AST. It fails on a `c.json`/`c.text` in a `catch` that reads the caught error's message on a path not narrowed by a typed `if`, an early `throw`, or `rethrowDatabaseError`. A `try` with no `await` is skipped. `apps/api/src/shared/database-errors.test.ts` pins the helper: it throws on a `DrizzleQueryError` or `PostgresError` in the cause chain and returns on an `EPIPE` socket error. Flow `SBX-4` asserts the duplicate-slug 409 (`code: template_slug_taken`) carries no SQL.
