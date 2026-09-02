# ADR-007: Convex data plane, Better Auth identity, One integration runtime

- **Status:** Proposed
- **Date:** 2026-09-02
- **Deciders:** Platform Engineering
- **Branch:** `convex-migration`

## Context

Kortix persists everything in PostgreSQL behind Supabase, authenticates with
Supabase Auth, and reaches third-party apps through Pipedream and Composio.
Measured on `main` at `488f774e48`:

| Surface | Size |
| --- | --- |
| Drizzle tables (`packages/db/src/schema`) | 128 |
| SQL migrations (`packages/db/migrations`) | 205 |
| SQL functions / triggers / RLS policies | 64 / 52 / 30 |
| API routes (`tests/spec/routes.generated.json`) | 635 |
| API files using `db.transaction` / row locks | 38 / 17 |
| Supabase Auth call sites: web / mobile+CLI | 45 files / 32 files |
| Connector provider call sites in `apps/api`: Pipedream / Composio | 29 / 13 |

Billing (`atomic_use_credits`, `atomic_settle_credits`, `atomic_add_credits`,
credit-ledger rollups), audit (11 `kortix.audit_*` triggers), and RBAC
mirroring (12 `kortix.rbac_*` functions) live in SQL. Account-level roles are
`owner | admin | member`; project-level roles are `manager | member`; groups,
resource grants, IAM policies, SCIM, SSO group sync, PATs, and session
lifetime policies sit on top.

The decision is to move the data plane to Convex, identity to Better Auth with
every plugin including organizations, and the integration layer to One
(withone.ai).

## Decision

### 1. Convex replaces PostgreSQL behind an unchanged API contract (strangler)

- The Hono API in `apps/api` stays the single client-facing contract. Its 635
  routes, `@kortix/sdk`, the CLI, mobile, and the black-box flows in `tests/`
  are unchanged by the persistence swap.
- Data invariants move into Convex functions written with `kitcn/orm`
  (`convexTable`, `.relations()`, `index()`), one mutation per former SQL
  function or trigger. Convex mutations are serializable transactions, which
  replaces `db.transaction` and `FOR UPDATE`.
- The API reaches Convex through `ConvexHttpClient` with a deploy-scoped
  admin key. Hosts never talk to Convex data directly; `apps/web` keeps
  reading through `@kortix/sdk`. `kitcn/react`, `kitcn/crpc`, and `kitcn/rsc`
  are not adopted.
- Reactive Convex subscriptions are a later, SDK-owned addition for hot paths.

### 2. Better Auth replaces Supabase Auth, with the full plugin set

- Better Auth runs inside Convex HTTP actions through `kitcn/auth`. Its tables
  live in the same Convex schema (kitcn local-install model, `plugins.lock.json`
  tracks managed tables).
- The API verifies Better Auth RS256 JWTs against `<convex-site>/convex/jwks`
  in `apps/api/src/shared/jwt-verify.ts`, replacing the Supabase JWKS fetch.
  `getToken` in hosts returns the Better Auth JWT. The SDK contract does not
  change.
- Plugin map (Better Auth 1.7.2; every `better-auth` and `@better-auth/*` package pinned to the same version so one `@better-auth/core` resolves — mixed 1.7.1/1.7.2 cores fail typecheck on `HookEndpointContext`):

| Plugin | Replaces in Kortix | Runtime | Status |
| --- | --- | --- | --- |
| `organization` (teams, dynamic access control, invitations) | `accounts`, `account_members`, `account_invitations`, `account_groups`, `iam_roles`, `iam_role_actions`, `role_assignments` | Convex | core of Phase 2 |
| `admin` | `platform_user_roles`, `impersonation_grants` | Convex | Phase 2 |
| `api-key` (org-owned keys) | `api_keys`, `account_tokens` (PATs), `service_accounts` | Convex | Phase 2; PAT lifetime policy hooks re-implemented |
| `two-factor` | `supabase.auth.mfa.*` (8 web call sites), `accounts.mfa_required` | Convex | Phase 1 |
| `passkey` (`@better-auth/passkey`) | none today | Convex | Phase 1 |
| `magic-link`, `email-otp` | `signInWithOtp`, `verifyOtp` | Convex | Phase 1 |
| `generic-oauth` + social providers (GitHub, Google) | `signInWithOAuth` | Convex | Phase 1 |
| `jwt`, `bearer`, `multi-session`, `one-time-token`, `device-authorization` | Supabase JWT, CLI browser login, `tunnel_device_auth_requests` | Convex | Phase 1 |
| `mcp` (wraps `oauth-provider`, OAuth 2.1; needs an explicit `jwt()` plugin with id `jwt`, RS256, sharing the `jwks` table with kitcn's embedded instance) | `apps/api/src/oauth/*`, `oauth_*` tables, MCP OAuth issuer | Convex | Phase 3 |
| `sso` (`@better-auth/sso`, OIDC + SAML) | `account_sso_providers`, `account_sso_group_mappings`, `iam/sso-sync.ts` | **Bun API** (see risk R1) | Phase 3 |
| `scim` (`@better-auth/scim`) | `apps/api/src/scim/*`, `scim_tokens`, `scim_external_id` | **Bun API** (see risk R2) | Phase 3 |
| `stripe` (`@better-auth/stripe`) | `billing_customers`, `stripe_webhook_events_processed` | Convex | Phase 3; credit ledger stays a Kortix mutation |
| `expo` | `apps/mobile` Supabase session handling | Convex | Phase 4 |
| `have-i-been-pwned`, `captcha`, `last-login-method`, `open-api`, `i18n` | none | Convex | Phase 1 |
| `username`, `anonymous`, `phone-number`, `siwe`, `one-tap` | none | Convex | Phase 1, enabled but not surfaced |

- Kortix role vocabulary maps onto `createAccessControl` statements: account
  `owner/admin/member` become organization roles; project `manager/member`
  become dynamic-access-control roles scoped by `organizationId`; teams model
  `account_groups`.

### 3. One (withone.ai) replaces Pipedream and Composio for connector auth and execution

- Connections use One Auth (project-owned, keyed by Kortix identity), not One
  Connect. Backend mints tokens with `POST https://api.withone.ai/v1/authkit/token`
  (`X-One-Secret`, body `{identity, identityType}`); execution uses
  `POST /v1/passthrough/{platform}/{resource}` with `x-one-connection-key`;
  inventory uses `GET /v1/vault/connections?identity=`.
- The API calls One over REST. `@withone/sdk` 0.4.0 is a native Rust binding
  and is not used.
- Pipedream stays for triggers only. One webhooks are dashboard-managed with no
  per-user subscription API (retries: 3, header `X-Webhook-Signature`).
- MCP, OpenAPI, HTTP, GraphQL, Postman, and channel providers are unchanged.

## Phases and gates

1. **Identity + spike.** Convex project under `convex/` with kitcn, Better
   Auth with every plugin above enabled, JWKS verification in the API,
   `accounts` and `api_keys` on Convex. Gate: `pnpm test -- --domain access`
   green against Convex; web sign-in, MFA enrolment, and CLI login through
   Better Auth on a preview origin.
2. **Core data.** Projects, sessions, secrets, IAM, RBAC. Dual-write behind
   `CONVEX_WRITE`, read behind `CONVEX_READ`. Gate: full local `pnpm test`
   green with both flags on.
3. **Billing, audit, enterprise.** Credit ledger, settlement, audit events,
   SSO, SCIM, OAuth provider. Gate: the #7080 zero-wallet hard-block scenario
   passes before and after; Entra SSO + SCIM runbook re-executed.
4. **Integration layer + clients.** One Auth connect flow, passthrough call
   path, mobile and CLI on Better Auth. Gate: Gmail and Slack connectors
   connect and execute on preview through One.
5. **Cutover.** Freeze, copy, flip `CONVEX_READ`, remove `packages/db`,
   Drizzle, Supabase. `self-host/` ships the self-hosted Convex backend.

## Risks and open items

- **R1 SSO in Convex.** `@better-auth/sso` depends on `samlify`, `@xmldom/xmldom`,
  and `fast-xml-parser`, which need Node. Convex HTTP actions run on V8. Plan:
  a second Better Auth instance mounted in the Bun API for SSO and SCIM,
  sharing the same Convex tables through an adapter that calls kitcn's
  generated auth functions over `ConvexHttpClient`. To be spiked in Phase 3.
- **R2 SCIM transactions.** `@better-auth/scim` requires an adapter with
  interactive transactions. kitcn's adapter declares `transaction: false`.
  Fallback: keep Kortix's existing SCIM implementation and point it at the
  Better Auth `user`, `member`, and `team` tables, one Convex mutation per SCIM
  request.
- **R3 kitcn schema drift.** kitcn 0.32.1 pins `better-auth >=1.7.0 <1.8.0`
  and `convex >=1.42 <1.45`. The `kitcn add auth` scaffold writes a `jwks`
  table without the `alg` field that Better Auth 1.7.1 inserts, so the first
  `kitcn dev --bootstrap` fails with `Object contains extra field 'alg'`.
  `kitcn add auth --schema --yes` regenerates the managed tables correctly
  (reproduced and fixed 2026-09-02 on kitcn 0.32.1, better-auth 1.7.1, convex
  1.44.0). Run the schema sync after every plugin or version change and pin
  exact versions in the workspace.
- **R3b kitcn 0.32.1 codegen omits `incrementOne`.** The Convex adapter calls
  `generated/auth:incrementOne` (organization creation increments counters),
  but `kitcn codegen` never exports it, so `POST /organization/create` fails
  with `Couldn't resolve api.generated.auth.incrementOne`.
  `apps/convex/scripts/patch-generated-auth.ts` appends the export after every
  codegen (wired into the package `codegen` script). Upstream has the symbol in
  `src/auth/create-api.ts` but not in the generated contract; drop the patch
  when a kitcn release exports it.
- **R3c Better Auth endpoint keys collide.** Plugins register endpoints by
  key; kitcn's `convex` plugin and `jwt()` both define `getJwks`/`getToken`,
  and Better Auth keeps the last one. `jwt()` is registered first so the
  `convex` endpoints (`/convex/jwks`, `/convex/token`) win, and `jwt()` uses
  `jwksPath: '/convex/jwks'` so OAuth discovery advertises the same JWKS.
  Better Auth logs `Endpoint path conflicts detected` for the shared path at
  every request; harmless, to be silenced once kitcn can skip its embedded jwt.
- **R3d Server-only endpoints.** `POST /api-key/verify` returns 404 over HTTP
  by design (server-only); the Kortix API calls `auth.api.verifyApiKey`.
  Requests carrying `x-api-key` resolve a session
  (`enableSessionForAPIKeys: true`), which is the PAT replacement path.
- **R4 One coverage.** 771 platforms versus the current Pipedream catalog.
  Produce a connector-by-connector diff before Phase 4 and keep unsupported
  connectors on Pipedream.
- **R5 Convex limits.** 8 MiB per document, 16,384 documents read per
  transaction. `session_transcript_messages`, `gateway_request_logs`, and
  `audit_events` need pagination-first access patterns and retention.
- **R6 Data copy.** Production row counts are not yet measured. Phase 5 needs
  a prod-shaped snapshot to time the copy and validate invariants.

## Consequences

- One data engine, one auth system, one integration runtime, no SQL.
- `packages/db`, node-pg-migrate, squawk, Supabase local, and the RLS layer
  are deleted at cutover. The `migration` and `learnings` skills gain a Convex
  section.
- `apps/api` becomes a thin contract layer over Convex functions. Future
  route logic that touches data lands in `convex/`.
- Self-host requires the Convex backend binary in place of PostgreSQL and
  Supabase.
