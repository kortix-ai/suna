---
recorded: 2026-09-29T11:25:36Z
incident_date: 2026-09-29
---
# Mark required JSON bodies required in OpenAPI routes

**Rule:** Set `request.body.required: true` on `@hono/zod-openapi` routes whose handler reads required JSON fields.

**Trigger surface:** A new or changed `OpenAPIHono` POST route with `c.req.valid('json')`.

**Incident:** On 2026-09-29, a bodyless curl probe to `POST /v1/auth/sign-in/password` caused 4 API TypeErrors. The route declared required `email` and `password` fields but did not mark the body required. `@hono/zod-openapi` skipped validation when the `content-type` header was absent and handed the handler `{}`. KRTX-741 fixed all nine headless auth POST routes.

**Enforcement:** `apps/api/src/__tests__/unit-auth-headless.test.ts` sends bodyless POSTs without `content-type` to every headless auth body route and requires a 400 validation error. The test failed with 500 on the original code and passes with `required: true`.
