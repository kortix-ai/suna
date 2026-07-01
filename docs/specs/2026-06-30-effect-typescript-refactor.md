# Effect TypeScript Refactor Spec

## Goal

Use Effect for API-side TypeScript workflows that combine request parsing,
validation, authorization, database/service calls, external I/O, billing, and
typed expected failures.

The route-layer target is complete: every Hono/OpenAPI route app gets an Effect
execution boundary, and workflow-heavy handlers additionally move request
parsing, validation, authorization, service calls, and expected failures into
typed Effect programs.

## Reference Material

- Effect source may be cloned locally under `repos/effect/` as read-only agent
  reference material, but it is intentionally untracked and excluded from this
  PR. Committing the full upstream repository makes review, secret scanning, and
  code scanning noisy without changing the application runtime.
- Runtime code imports from the normal `effect` package dependency, never from
  `repos/effect`.
- `AGENTS.md` documents that external source references are local-only and must
  not be imported from application code.

## Migration Rules

1. Keep framework boundaries thin.
   Hono handlers should extract transport values, run an Effect workflow, and
   map typed success/failure to HTTP responses.

2. Model expected failures in the error channel.
   Auth failures, not-found cases, provider errors, validation failures, and
   billing-system failures should be explicit route errors instead of nested
   anonymous `try/catch` branches.

3. Decode untrusted data at the edge when the shape is external.
   Provider JSON is decoded with `effect/Schema` before becoming internal
   result objects.

4. Preserve public contracts.
   Existing status codes, response fields, defaulting behavior, header behavior,
   and fire-and-forget side effects are compatibility gates.

5. Keep dependencies scoped.
   `apps/api` owns the runtime `effect` dependency. Do not add Effect to other
   packages unless a migrated workflow lives there.

6. Keep transport mechanics thin, but still inside an Effect boundary.
   Raw `Request.text()` for signatures, streaming response bodies, websocket
   upgrade handoff, retry loops that pipe byte streams, and mount/schema files
   may stay as direct Hono code, but the containing route app still uses
   `effectMiddleware`.

## Shared Helpers

- `apps/api/src/effect/http.ts`
- `apps/api/src/effect/hono.ts`
- `apps/api/src/accounts/effect-workflows.ts`
- `apps/api/src/billing/routes/effect-workflows.ts`
- `apps/api/src/channels/effect-workflows.ts`
- `apps/api/src/executor/effect-workflow.ts`
- `apps/api/src/projects/routes/effect-workflows.ts`
- `apps/api/src/router/services/search-workflow.ts`
- `apps/api/src/router/services/llm-workflow.ts`
- `apps/api/src/sandbox-proxy/routes/effect-workflows.ts`
- `apps/api/src/tunnel/routes/effect-workflows.ts`

## Migrated Route Families

### Router

- Search routes and providers:
  - `apps/api/src/router/routes/search-web.ts`
  - `apps/api/src/router/routes/search-image.ts`
  - `apps/api/src/router/services/tavily.ts`
  - `apps/api/src/router/services/serper.ts`
- LLM routes:
  - `apps/api/src/router/routes/llm.ts`
  - `apps/api/src/router/routes/anthropic.ts`
  - `apps/api/src/router/routes/session-llm.ts`

Preserved contracts include request validation, credit checks, upstream error
pass-through, SSE response headers, tool-call payload forwarding, and billing
side effects.

### Executor

- `apps/api/src/executor/router.ts`

Catalog/call/admin/policy/Pipedream/sharing workflows now run through Effect.
Per-agent connector denial, policy statuses, project-explicit gateway routes,
and Cloudflare-safe `500` upstream error bodies are preserved.

### Billing

- `apps/api/src/billing/routes/account-deletion.ts`
- `apps/api/src/billing/routes/account-state.ts`
- `apps/api/src/billing/routes/credits.ts`
- `apps/api/src/billing/routes/payments.ts`
- `apps/api/src/billing/routes/subscriptions.ts`
- `apps/api/src/billing/routes/webhooks.ts`

Raw Stripe body reading remains explicit for signature verification. Service
calls and expected route failures run through Effect.

### Accounts

- `apps/api/src/accounts/core/accounts.ts`
- `apps/api/src/accounts/core/members.ts`
- `apps/api/src/accounts/core/tokens.ts`
- `apps/api/src/accounts/invites.ts`

Account list/create/detail/rename, member lifecycle, PAT lifecycle, and invite
describe/accept/decline workflows now use Effect. Invite bootstrap-grant
application remains a best-effort helper because individual project-grant
failures must not roll back invite acceptance.

### Projects

- Low-risk project routes:
  - `apps/api/src/projects/routes/model-defaults.ts`
  - `apps/api/src/projects/routes/public-shares.ts`
  - `apps/api/src/projects/routes/setup-links.ts`
  - `apps/api/src/projects/routes/r6.ts`
- Focused handlers in:
  - `apps/api/src/projects/routes/r1.ts`
  - `apps/api/src/projects/routes/r2.ts`
  - `apps/api/src/projects/routes/r3.ts`
  - `apps/api/src/projects/routes/r4.ts`
  - `apps/api/src/projects/routes/r5.ts`
  - `apps/api/src/projects/routes/r7.ts`
  - `apps/api/src/projects/routes/r8.ts`
  - `apps/api/src/projects/routes/r9.ts`
  - `apps/api/src/projects/routes/r10.ts`
  - `apps/api/src/projects/routes/gateway.ts`
  - `apps/api/src/projects/routes/shared.ts`

High-risk session lifecycle, streaming, commit/archive streaming, and long
stateful provisioning paths include deliberate comments where promise-linear
control flow remains clearer.

### Tunnel

- `apps/api/src/tunnel/routes/auth.ts`
- `apps/api/src/tunnel/routes/audit.ts`
- `apps/api/src/tunnel/routes/connections.ts`
- `apps/api/src/tunnel/routes/device-auth.ts`
- `apps/api/src/tunnel/routes/permission-requests.ts`
- `apps/api/src/tunnel/routes/permissions.ts`
- `apps/api/src/tunnel/routes/rpc.ts`

Auth context, DB calls, validation, and expected route errors are Effect-backed.
Permission-request SSE stream plumbing remains raw stream glue.

### Channels

- `apps/api/src/channels/email/routes.ts`
- `apps/api/src/channels/slack/routes.ts`
- `apps/api/src/channels/slack/identity-routes.ts`

AgentMail/Slack signature checks, parsing, dedupe, secret lookup, expected
auth failures, and dispatch scheduling are modeled through Effect. Channel app
mount files inherit the shared OpenAPI Effect boundary.

### Proxy, Platform, Gateway

- `apps/api/src/sandbox-proxy/routes/auth.ts`
- `apps/api/src/sandbox-proxy/routes/preview.ts`
- `apps/api/src/sandbox-proxy/routes/share.ts`
- `apps/api/src/sandbox-proxy/routes/public-share.ts`
- `apps/api/src/platform/routes/version.ts`
- `apps/api/src/platform/webhooks/routes.ts`
- `apps/api/src/llm-gateway/internal-routes.ts`

Ownership checks, webhook handler calls, gateway control-plane calls, and
version-provider fetch/decode/cache logic are Effect-backed. Upstream byte
stream pass-through, retry loops, websocket upgrade handoff, and raw webhook
body semantics remain imperative.

## Final Coverage Sweep

The final pass adds `effectMiddleware` to:

- `makeOpenApiApp()` so all OpenAPI route apps are covered at creation time.
- The root API app in `apps/api/src/index.ts`.
- Raw `new Hono()` apps that bypass `makeOpenApiApp()`:
  `projectWebhooksApp`, setup-link public routes, in-process LLM gateway
  routes, internal gateway routes, preview proxy routes, and public-share proxy
  routes.

Files that are mostly schemas, mount order, side-effect route registration, or
transport helpers can therefore remain thin without being outside the Effect
runtime boundary.

## Explicit Transport Exceptions

- `apps/api/src/billing/routes/webhooks.ts` still reads raw Stripe text outside
  schema validation because signature verification requires the exact body.
- Preview proxy streaming and websocket upgrade paths keep direct `Response`
  and URL/headers plumbing.

## Verification

Green checks run in the integrated worktree:

- `pnpm --filter kortix-api exec tsc --noEmit --pretty false`
- `git diff --check`
- Static coverage scan: every route-shaped `apps/api/src/**/*.ts` file
  containing `new Hono`, `new OpenAPIHono`, `makeOpenApiApp`, `createRoute`,
  or `.openapi(` also contains an Effect boundary marker
  (`Effect`, `effectMiddleware`, `effectHandler`, `makeOpenApiApp`, or a
  route-family Effect workflow helper).
- Static import guard: application/packages code imports from the runtime
  `effect` dependency, not from `repos/effect`.
- Router: `e2e-router.test.ts`, `e2e-session-llm-router.test.ts`
- Executor: `e2e-executor.test.ts`, `e2e-executor-faces.test.ts`, selected
  `unit-executor-*` suites
- Billing: `billing/account-deletion.test.ts`, `billing/subscriptions.test.ts`,
  `billing/auto-topup-validation.test.ts`, `billing/webhooks.test.ts`,
  `e2e-billing-routes.test.ts`
- Accounts: `e2e-accounts-contract.test.ts`
- Projects: `e2e-projects-contract.test.ts`,
  `e2e-project-session-contract.test.ts`, `e2e-project-limit.test.ts`,
  `e2e-project-apps.test.ts` with `KORTIX_APPS_EXPERIMENTAL=true`
- Proxy/platform/gateway: `e2e-preview-proxy.test.ts`,
  `platform/webhooks/sandbox-webhooks.test.ts`,
  `llm-gateway/internal-auth.test.ts`,
  `llm-gateway/models/catalog-models.test.ts`,
  `unit-public-session-share.test.ts`, `unit-share-endpoint.test.ts`
- Tunnel: `unit-tunnel-auth.test.ts`,
  `unit-tunnel-cluster-forwarder.test.ts`
- Channels: `unit-email-channel.test.ts`,
  `unit-slack-webhook-url-verification.test.ts`,
  `channels/slack/__tests__/login.test.ts`,
  `channels/slack/__tests__/commands-identity-on.test.ts`
- Earlier live/local black-box checks passed for router search and tunnel ke2e
  in this worktree.
- After rebasing onto current `origin/main`, worktree HTTP smoke passed for:
  - `GET http://localhost:15108/v1/health`
  - `GET http://localhost:15108/v1/router/health`
  - `GET http://localhost:15190/health/live`
  - protected routes returning `401` without auth
- Final sweep HTTP smoke also passed for:
  - `GET http://localhost:15108/scim/v2/accounts/.../ServiceProviderConfig`
    returning SCIM `401` without auth
  - `GET http://localhost:15108/v1/setup-links/secret/not-a-token` returning
    the expected invalid-link `404`
- Final sweep isolated focused reruns passed:
  - IAM/accounts: 95 tests across IAM unit suites and
    `e2e-accounts-contract.test.ts`
  - Projects/migration: `e2e-projects-contract.test.ts` alone,
    `unit-legacy-migration-routes.test.ts`,
    `e2e-project-session-contract.test.ts`,
    `e2e-project-session-branch-git.test.ts`, with the live migration tooling
    cases skipped by their suite gates
  - Router/proxy/gateway:
    `e2e-router.test.ts`, `e2e-session-llm-router.test.ts`,
    `e2e-preview-proxy.test.ts`, `unit-public-session-share.test.ts`,
    `unit-share-endpoint.test.ts`, `unit-preview-proxy-budget.test.ts`,
    `unit-router-provider-trace.test.ts` alone, and
    `unit-executor-gateway.test.ts`
  - Billing: `e2e-billing-routes.test.ts`, billing webhooks/subscriptions,
    auto-topup validation, and `billing/account-deletion.test.ts` alone
  - Channels/tunnel: Slack channel tests, `unit-email-channel.test.ts` alone,
    `unit-tunnel-auth.test.ts`, and `unit-tunnel-cluster-forwarder.test.ts`

Known residuals:

- Large combined Bun invocations can fail from mock-module leakage across
  unrelated suites. This was reproduced during the final sweep; the same
  affected files passed when rerun in isolation.
- A final authenticated HTTP smoke was blocked by the shared local Supabase DB:
  admin user creation returned `500` with `Database error checking email`.
- A later ke2e router rerun failed before test execution because
  `KE2E_SUPABASE_SERVICE_ROLE_KEY` and `KE2E_SUPABASE_ANON_KEY` were not set in
  that shell.
