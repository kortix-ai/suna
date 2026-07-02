# suna

## What this codebase does

Kortix is an open/self-hostable AI command center: company/project state lives in a git repo, sessions boot isolated cloud sandboxes, OpenCode runs inside each sandbox, and humans review agent change requests. This is a pnpm/Bun/TypeScript monorepo with a Hono API (`apps/api`), Next.js web app (`apps/web`), CLI/desktop/mobile apps, `@kortix/sdk` as the backend client source of truth, a sandbox agent server (`apps/kortix-sandbox-agent-server`), Supabase auth/DB, Stripe billing, Daytona/Platinum sandbox providers, Slack/Telegram/email/Meet webhooks, Executor connectors, and GitOps infra.

## Auth shape

- API auth primitives are `apiKeyAuth`, `supabaseAuth`, and `combinedAuth` in `apps/api/src/middleware/auth.ts`. They set Hono context variables (`userId`, `accountId`, `authType`, `tokenProjectId`, `sessionId`, `iamTokenId`, `agentGrant`).
- `supabaseAuth` accepts Supabase JWTs, CLI PATs (`kortix_pat_...`), service-account tokens, and a narrow sandbox-token exception for clone credentials / turn stream / questions / catalog.
- `combinedAuth` is used for preview proxy, Executor admin, tunnel, secrets, providers and other mixed-token routes. It intentionally allows `?token=` only for `/v1/p/*` preview/WS and provision-stream flows.
- Project routes mount `projectsApp.use('/*', supabaseAuth)` first; per-resource authorization is via IAM helpers such as `authorize`, `assertAuthorized`, `assertProjectCapability`, `requireScope`, `resolveProjectAccount`, and `loadProjectForUser`.
- Sandbox daemon proxy auth uses `X-Kortix-User-Context`, verified by `verifyKortixUserContext` with `KORTIX_TOKEN`; `/kortix/health` is the intentional unauthenticated liveness/control exception.

## Threat model

Highest impact: cross-account/project access to repos, sessions, secrets, connectors, billing credits, or sandbox preview/file/terminal surfaces. Next: abusing LLM/tool proxy routes to spend Kortix-managed keys or bypass route/model allowlists and billing. Also important: forged webhooks/setup links/device-auth flows that start sessions or write secrets, and sandbox escape paths through preview proxy, file APIs, git credentials, env injection, or forwarded user context.

## Project-specific patterns to flag

- Hono routes that mutate project/account/session/connector/secrets state without `supabaseAuth`/`combinedAuth` plus an IAM gate (`assertAuthorized`, `assertProjectCapability`, `requireScope`, or equivalent).
- Preview/proxy code that forwards auth headers, `X-Kortix-Token`, `x-api-key`, cookies, or user-context headers to upstream apps; proxy helpers should strip or replace credentials deliberately.
- Any new query-token auth outside the documented preview/provision-stream exceptions, or preview cookie widening beyond `Path=/v1/p/`, `HttpOnly`, `Secure`, `SameSite=Lax`.
- Public token-gated surfaces (`setup-links`, device auth, webhooks, OAuth token, Slack/Telegram/email/Meet callbacks) must validate signatures, encrypted token payloads, expiry, idempotency, and scoped write targets.
- Sandbox agent server routes (`/file`, `/find`, `/presentation`, `/proxy`, `/web-proxy`, PTY websocket) should remain behind verified `X-Kortix-User-Context`; health/readiness endpoints are intentionally lighter.

## Known false-positives

- `GET /health`, `/v1/health`, `/health/live`, `/metrics` (when enabled), `/v1/system/status`, `/v1/system/maintenance` GET, and frontend marketing/docs routes are intentionally public.
- `projectWebhooksApp` is public by mount but validates project trigger slug plus HMAC signature or fallback shared token from the trigger secret before firing.
- `setupLinksPublicApp` is intentionally unauthenticated; the `ksl_` token is an encrypted, short-lived, value-only capability scoped to one project and named fields/connector.
- `/v1/tunnel/device-auth` public routes are part of CLI device auth; non-device-auth tunnel routes go through `combinedAuth`.
- Tests, generated starter snapshots, encrypted dotenvx env files, docs/specs, and sample fixtures can contain fake secrets, placeholder tokens, broad CORS examples, or intentionally insecure snippets.
