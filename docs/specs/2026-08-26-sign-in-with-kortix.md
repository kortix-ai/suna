# Sign in with Kortix — the SDK owns third-party auth end to end

Status: in progress (branch `sign-in-with-kortix`). Owner: Marko.

## Problem

A third-party app (first case: Essentia's dashboards app, a Kortix App on the
Essentia self-host) wants to gate itself behind Kortix identity, know WHO the
viewer is, ask Kortix IAM what the viewer may do, and share its own resources
between Kortix users. Today `@kortix/sdk` is token-in only (`getToken`). There
is no "Sign in with Kortix" for an app on its own origin:

- `/v1/oauth` is a half-built provider: `oauth_clients` rows are inserted by
  hand, pending authorizations live in an in-process `Map`, there is no
  discovery, and a `kortix_oat_` token opens only `/v1/oauth/userinfo`.
- The Kortix Apps access gate authenticates the viewer at the edge but never
  tells the container who they are (`apps/api/src/apps/public-proxy.ts`
  `appUpstreamHeaders`).
- The documented path (`docs/sdk/auth.mdx`) is "embed supabase-js against
  Kortix's Supabase project" — a tenant leak, and not a product feature.

## Decision

Complete the Kortix-native OAuth 2.1 provider and put the whole wrapper-app
auth lifecycle into `@kortix/sdk`, so a standalone app needs ONLY
`npm install @kortix/sdk` + a client id/secret + `backendUrl`, and works against
kortix.com and every self-host identically. Supabase never appears in the
contract.

Not chosen: Supabase's own OAuth server (per-project dashboard toggle, version-
dependent on self-host, vendor config outside IaC — see learnings 2026-08-18
"one OAuth provider per concern"). Not chosen: forwarding identity from the
Apps gate as the primary path (only works for Kortix-hosted apps).

## Contract

### API (`apps/api`)

| Route | Auth | Purpose |
|---|---|---|
| `GET /.well-known/oauth-authorization-server` and `GET /v1/oauth/.well-known/oauth-authorization-server` | open | RFC 8414 metadata. `issuer` = `KORTIX_URL`. |
| `GET /v1/oauth/authorize` | open | `response_type=code`, `client_id`, `redirect_uri` (exact match), `scope`, `state`, `code_challenge` (S256 only). Persists the request in `oauth_authorization_requests`; 302 → `${FRONTEND_URL}/oauth/authorize?request_id=…`. |
| `GET /v1/oauth/authorize/consent/{requestId}` | user | Consent screen data. Includes `remembered: true` when the user already granted this client ⊇ scopes. |
| `POST /v1/oauth/authorize/consent` | user | `{request_id, approved}` → `{redirect_uri}`. Approval writes `oauth_consents`. |
| `POST /v1/oauth/token` | client | `authorization_code` / `refresh_token`. `client_secret` required for `confidential` clients, forbidden for `public` clients (PKCE only). |
| `POST /v1/oauth/revoke` | client | RFC 7009. Revokes an access or refresh token (and its pair). |
| `GET /v1/oauth/userinfo` | `kortix_oat_` | `{sub, user_id, account_id, email}`; needs `profile`. |
| `GET/POST /v1/accounts/{accountId}/iam/oauth-clients` | `token.read` / `token.create` | List / register. Create returns `client_secret` once (confidential) . |
| `GET/PATCH/DELETE …/oauth-clients/{clientId}` | `token.read` / `token.create` / `token.revoke` | Read / update name, description, redirect URIs, scopes, active / delete. |
| `POST …/oauth-clients/{clientId}/rotate-secret` | `token.create` | New secret, returned once. |

Scopes: `profile` (identity: user id, account id, email), `email` (alias kept
for OIDC-shaped clients), `kortix` (act as the user on the whole Kortix API).
`kortix` is what makes `kortix_oat_` a first-class credential:
`combinedAuth` and `supabaseAuth` resolve it to `authType: 'oauth'`,
`userId` = the granting user, no agent grant, no project binding. Without
`kortix` the token reaches only `/v1/oauth/userinfo` and `/v1/accounts/me`.

Tokens: access 1 h, refresh 30 d, rotation on refresh (existing). Request ids,
codes and tokens are stored hashed (existing `token-hash.ts`).

### DB (`packages/db`)

- `oauth_clients` + `account_id` (FK accounts, cascade, nullable for legacy
  platform rows), `created_by`, `description`, `client_type`
  (`confidential | public`), `updated_at`.
- new `oauth_authorization_requests` (replaces the in-memory Map; survives
  restarts and works across replicas).
- new `oauth_consents` (`user_id`, `client_id`, `scopes`, `granted_at`;
  unique per user+client) — remembered consent, so a returning viewer is
  redirected straight back without the Allow screen.

Additive DDL only. No backfill.

### SDK (`packages/sdk`)

`@kortix/sdk/server` (Node/Bun, framework-free — Web `Request`/`Response`):

```ts
import { createKortixAuth } from '@kortix/sdk/server';

export const auth = createKortixAuth({
  backendUrl: 'https://api.kortix.com/v1',
  clientId: process.env.KORTIX_OAUTH_CLIENT_ID!,
  clientSecret: process.env.KORTIX_OAUTH_CLIENT_SECRET,   // omit for a public client
  redirectUri: 'https://dashboards.example.com/api/kortix/auth/callback',
  cookieSecret: process.env.KORTIX_AUTH_COOKIE_SECRET!,   // ≥ 32 chars
});
```

| Member | What it does |
|---|---|
| `handler(request)` | One catch-all route. `/signin` (PKCE + state cookie, 302 to Kortix), `/callback` (code → tokens, encrypted session cookie, 302 `returnTo`), `/refresh` (rotate, 302), `/signout` (revoke, clear, 302), `/me` (JSON viewer or 401), `/proxy/*` (same-origin forward to Kortix as the viewer — the browser SDK's `backendUrl`). |
| `viewer(request)` | `{ userId, email, accounts, token, expiresAt } \| null`. Read-only; never burns a refresh token. |
| `requireViewer(request)` | `{ viewer }` or `{ response }` — a 302 to `/refresh` (session refreshable) or `/signin` (not). For middleware. |
| `kortix(request)` | `createScopedKortix` bound to the viewer's token. |
| `signInUrl(returnTo)`, `signOutUrl(returnTo)` | Link targets. |
| `clientConfig()` | `{ backendUrl: '<basePath>/proxy', getToken }` for `createKortix` in the browser. |

Cookie: AES-256-GCM over `{at, rt, exp, uid}` with a key derived from
`cookieSecret` (WebCrypto, no `node:` import). `__Host-` prefix on https.
`returnTo` must be a same-origin path.

`@kortix/sdk` (root): `kortix.iam.oauthClients.{list,get,create,update,remove,rotateSecret}`.

`@kortix/sdk/react`: `SignInWithKortix` (anchor to `/signin`), `useKortixViewer()`
(reads `/me`).

Docs: `docs/sdk/sign-in.mdx`, `auth.mdx` table row, `accounts.mdx` OAuth apps
paragraph, README. Example: `packages/sdk/examples/sign-in-with-kortix.ts`.
`scripts/smoke-install.mjs` imports `createKortixAuth` from the packed tarball.

### Web (`apps/web`)

- Account hub → Tokens: "OAuth apps" card (register, redirect URIs, scopes,
  type, secret shown once, rotate, delete).
- Consent page: scope copy for `kortix`; remembered consent skips the screen.
- `lib/agent-discovery.ts` `auth.md`: self-serve client registration.

## Verification

1. API unit tests (bun): token acceptance for `kortix_oat_` on `combinedAuth`
   + `supabaseAuth`, scope gate, public vs confidential `/token`, request
   persistence, remembered consent, revoke, discovery, client CRUD authz.
2. SDK: `typecheck` + `test` + `smoke:install`; new tests for the auth kit
   drive the full flow against a fake Kortix (`fetch` stub) — PKCE, state,
   cookie round-trip, refresh rotation, proxy header rewrite, `returnTo`
   validation, signout revocation.
3. Local stack (worktree api `:20508`, web `:20500`): register a client in the
   UI, run essentia-dashboards with the kit against it, sign in through the
   real consent screen in Chromium, assert `/me`, `/proxy/projects`, and
   `iam.can` as the viewer.
4. Dev: same flow against `https://dev-api.kortix.com` after Deploy Dev; record
   the deployed SHA.

## Phase B — regular auth, headless (added 2026-08-26)

Requirement (Marko): the API must be usable "completely headless — whatever way
you want", including ordinary sign-up / sign-in, through the API and the SDK,
with no Supabase in the client contract. Today `apps/web` calls supabase-js
directly for `signUp`, `signInWithPassword`, `signInWithOtp`, `verifyOtp`,
`signInWithOAuth` + `exchangeCodeForSession`, `resetPasswordForEmail`,
`updateUser`, `signOut`. The API owns only `/v1/auth/logout`.

### API — `/v1/auth/*` (public unless marked; every call is a server-side
GoTrue request with the API's own key, the client IP forwarded for GoTrue's
rate limits, plus a Kortix per-IP token bucket)

| Route | Body | Returns |
|---|---|---|
| `POST /v1/auth/signup` | `{email, password, data?, redirect_to?}` | `{user, session\|null, requires_email_confirmation}` |
| `POST /v1/auth/sign-in/password` | `{email, password}` | `{session, user}` |
| `POST /v1/auth/sign-in/magic-link` | `{email, create_user?, redirect_to?, data?}` | `{sent: true}` |
| `POST /v1/auth/verify-otp` | `{email, token, type}` (`magiclink\|signup\|recovery\|email`) | `{session, user}` |
| `POST /v1/auth/sign-in/oauth` | `{provider, redirect_to, scopes?}` | `{url, code_verifier}` — PKCE; the client keeps the verifier |
| `POST /v1/auth/oauth/exchange` | `{code, code_verifier}` | `{session, user}` |
| `POST /v1/auth/refresh` | `{refresh_token}` | `{session, user}` |
| `POST /v1/auth/password/reset` | `{email, redirect_to?}` | `{sent: true}` |
| `POST /v1/auth/password/update` (bearer) | `{password}` | `{user}` |
| `GET /v1/auth/user` (bearer) | — | `{user}` |
| `POST /v1/auth/sign-out` (bearer) | `{scope?}` | `{ok: true}` — GoTrue logout + the existing audit/session revoke |

`session` = `{access_token, refresh_token, token_type, expires_in, expires_at}`.
Errors are GoTrue's, normalised to `{error, error_description}` with the
upstream status. `redirect_to` values must be on Supabase's redirect
allow-list (deployment config, documented). MFA stays on the web app for now
(documented gap).

### SDK

`kortix.auth.{signUp, signInWithPassword, sendMagicLink, verifyOtp,
signInWithProvider, exchangeCode, refresh, resetPassword, updatePassword,
user, signOut}` — unauthenticated calls go straight to `backendUrl`; bearer
calls use the token passed in. `createKortixSession({ storage?, onChange? })`
keeps a session, refreshes it 60 s before expiry through `kortix.auth.refresh`,
and exposes `getToken` for `createKortix`. Docs: `docs/sdk/auth.mdx` gains a
"Headless sign-in" section.
