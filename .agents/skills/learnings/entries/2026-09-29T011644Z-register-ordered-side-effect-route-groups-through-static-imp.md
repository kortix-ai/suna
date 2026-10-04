---
recorded: 2026-09-29T01:16:44Z
incident_date: 2026-09-29
---
# Register ordered side-effect route groups through static imports of a shared module, never through top-level await import

**Rule:** When a route file must register middleware BEFORE sibling route files register
their routes, put the registration in its own module and make every route file import it
statically, first. Never sequence side-effect registrations with top-level
`await import()` inside a route file: a static import always hoists above the module
body, so the sibling routes register before the middleware and skip it; and under bun
the awaited registrations land after Hono builds the router matcher, so every
registration after the first fetch throws "Can not add a route since the matcher is
already built" and the routes 404.

**Trigger surface:** Splitting or reordering any `apps/api/src/projects/routes/*.ts`
side-effect registration file — middleware or routes registered on a shared app
(`projectsApp`) where Hono dispatches in registration order.

**Incident:** 2026-09-29, PR #8117 (KRTX-292, split of `projects/routes/secrets.ts`).
The first build used `await import('./secret-personal')` after the write rate limit
inside `secrets.ts` to keep registration order. In bun test the personal and sync
routes registered after the matcher built: every secrets route 404'd in five suites
(the personal/sync routes also skipped the rate limit, which the current design would
have hidden). A minimal Hono + TLA repro outside bun worked, which made the failure
look test-specific; the reproducible fact is bun registering the dynamically imported
module after the fetch. Fixed by `routes/secret-rate-limit.ts`, imported first by
`secrets.ts`, `secret-personal.ts` and `secret-sync.ts`.

**Enforcement:** `bun tests/bin/ke2e.ts coverage` and the route-level suites
(`unit-secrets-sync-route`, `unit-project-secret-strategy-route`,
`secret-create-validation`) 404/throw the moment a secrets route registers late or
skips the write rate limit. Run them after any change to the secrets route files'
import order.
