# Effect TypeScript Refactor Spec

## Goal

Make the correct eventual claim true: the backend uses Effect as its primary
application architecture, not merely as a route wrapper.

The first route-layer target is complete: every Hono/OpenAPI route app gets an
Effect execution boundary, and workflow-heavy handlers additionally move request
parsing, validation, authorization, service calls, and expected failures into
typed Effect programs.

The full-backend target is stricter and remains in progress. It requires
backend dependencies, external I/O, resource lifecycles, retries, streaming,
and background concurrency to be modeled through Effect services, Layers,
Schema, Schedule, Stream, Scope, and structured concurrency where those
primitives apply.

Until the strict architecture audit passes, the accurate claim is:

> API routes and selected workflows are Effect-refactored; the backend is being
> migrated toward a full Effect architecture.

Do not claim "the backend uses the complete/full extent of Effect everywhere"
until the full-backend requirements below are satisfied and verified.

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

## Full-Backend Effect Architecture Requirements

These are the requirements for the stronger backend-wide claim:

1. Core dependencies are services.
   Config, database, Supabase, HTTP clients, Stripe, sandbox providers,
   LLM providers, logging/telemetry, and other shared infrastructure must be
   accessed through `Context.Tag` services provided by `Layer`s. Direct imports
   from global singleton modules are compatibility shims only and should not be
   used in newly migrated Effect workflows.

2. The application has a live layer.
   Runtime execution goes through a central live layer that provides backend
   services. Tests may provide test layers instead of monkey-patching globals.

3. External boundaries are decoded.
   Untrusted provider responses, webhook payloads after raw signature checks,
   env/config payloads, and internal service-to-service JSON are decoded with
   `effect/Schema` before being treated as typed internal data.

4. Retries use schedules.
   Provider retry/backoff, polling loops, and transient network/database retry
   paths use `Schedule` instead of hand-rolled `setTimeout` loops when the
   control flow is not pure transport byte forwarding.

5. Streams use Effect streams where they are application streams.
   SSE parsing, provider event streams, and internal event pipelines use
   `Stream` where the application consumes, transforms, retries, or accounts
   for chunks. Raw byte pass-through may remain direct only at the transport
   adapter edge.

6. Resource lifecycles are scoped.
   Connections, leases, timers, subscriptions, and background resources that
   require cleanup are acquired through `Scope` / `Effect.acquireRelease` or
   equivalent scoped Effect APIs.

7. Background work is structured.
   Fire-and-forget promises, intervals, and detached async tasks are migrated
   to Effect fibers, supervisors, queues, pub/sub, or explicit daemon processes
   so failures and shutdown behavior are observable.

8. The audit is enforceable.
   `pnpm --filter kortix-api audit:effect:architecture:strict` must pass before
   the full-backend claim is made. The report-only audit is allowed to fail the
   claim during migration, but it must make remaining direct infrastructure and
   missing primitives visible.

## Shared Helpers

- `apps/api/src/effect/http.ts`
- `apps/api/src/effect/hono.ts`
- `apps/api/src/effect/services.ts`
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

The final pass makes route coverage explicit and enforceable:

- `makeOpenApiApp()` so all OpenAPI route apps are covered at creation time.
- The root API app in `apps/api/src/index.ts`.
- Raw `new Hono()` apps that bypass `makeOpenApiApp()`:
  `projectWebhooksApp`, setup-link public routes, in-process LLM gateway
  routes, internal gateway routes, preview proxy routes, and public-share proxy
  routes.
- Every OpenAPI `createRoute(...)` registration now passes an explicit
  `effectHandler(...)`, `run*Effect(...)`, or route-family Effect workflow
  handler. The central middleware remains a safety net, not the only proof.
- `pnpm --filter kortix-api audit:effect` fails if a future OpenAPI route is
  registered without an explicit Effect boundary or a raw Hono app is created
  without Effect middleware/factory coverage.

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
- `pnpm --filter kortix-api audit:effect`: 423/423 OpenAPI route
  registrations have explicit Effect boundaries, and raw Hono app creation is
  guarded by `effectMiddleware` or `makeOpenApiApp()`.
- `pnpm --filter kortix-api audit:effect:architecture`: reports full-backend
  Effect architecture coverage and remaining direct infrastructure usage.
- `pnpm --filter kortix-api audit:effect:architecture:strict`: must pass before
  claiming the backend uses the complete/full extent of Effect everywhere.
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
