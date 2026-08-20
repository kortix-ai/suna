# SDK auth module — `createKortixAuth` + `/v1/auth/config` discovery

Date: 2026-08-19
Status: spec, awaiting review
Session: `claude/sdk-central`
Branch: `sdk-central` (worktree `/Users/markokraemer/Projects/kortix/suna-sdk-central`, HEAD `133dcfe088`)
Scope: `packages/sdk` (new `core/auth/*`, root-barrel exports), `apps/api` (one new public route), `tests/*` (one new flow + manifest), `apps/web/content/docs/sdk/auth.mdx` (one new section)

---

## 1. Problem

`@kortix/sdk` can do everything with a token and nothing to get one.

`createKortix({ backendUrl, getToken })` requires the host to already hold a
credential. Today there are exactly two ways to satisfy it:

1. Paste a long-lived `kortix_pat_…` / `kortix_sa_…` secret. Correct for CI, a
   CLI, or a backend. Wrong for an app with human users — one shared secret for
   every visitor, no per-user identity, no revocation per person.
2. Install `@supabase/supabase-js`, discover the deployment's GoTrue URL and
   anon key out of band, and re-implement token caching and refresh.

Option 2 is what `apps/web` does, and it costs 209 lines
(`apps/web/src/lib/auth-token.ts`) of cache/single-flight/expiry logic plus a
`@supabase/ssr` client. Any third party building on Kortix has to rediscover the
same code, including the non-obvious parts:

- `supabase.auth.getSession()` returns the **stored** session even when its
  `access_token` has already expired — it does not refresh. Handing that token
  to a caller produces a `401`; on a surface with no `401` recovery (the PTY
  WebSocket) that becomes an endless `1006` reconnect loop.
  (`apps/web/src/lib/auth-token.ts:164-177`.)
- Five subsystems race for a token on page load (SSE, health check, session
  fetch, …). Without single-flight deduplication each one triggers its own
  `getSession()` → `refreshSession()` chain. (`auth-token.ts:12-16`.)
- A token that cannot be parsed must be *used*, not discarded: let the server be
  the judge. (`auth-token.ts:134-149`.)

And the second half of the problem is discovery. Even with the code, a third
party cannot reach GoTrue without two values it has no supported way to obtain:
the **public** GoTrue origin and the **anon key**. `apps/web` gets them from
build-time env (`apps/web/src/lib/env-config.ts:29-30`); a `npm install
@kortix/sdk` consumer pointed at `https://api.kortix.com/v1` gets nothing. There
is no route that answers "where do I sign in against this deployment?".

**The ask:** any first- or third-party app does full Kortix login through the SDK
alone —

```ts
const auth = createKortixAuth({ backendUrl: 'https://api.kortix.com/v1' });
const kortix = createKortix({ backendUrl: 'https://api.kortix.com/v1', getToken: auth.getToken });
```

### 1.1 Reconciling with "Auth is exactly one seam"

`packages/sdk/AGENTS.md:67-71` says:

> **Auth is exactly one seam:** `getToken`. … Everything else — REST calls and
> the proxied runtime alike — flows through `authenticatedFetch`, which attaches
> it. There is no second auth path. Do not add one.

This module does not violate that rule, and the distinction is worth stating
precisely because it is the one thing a reviewer will challenge.

**`createKortixAuth` is a token *producer*, not a transport.** It is on the
supply side of the seam, not a way around it:

| | `authenticatedFetch` (the seam) | `createKortixAuth` (a producer) |
|---|---|---|
| Talks to | Kortix REST + the runtime proxy | GoTrue only, plus one unauthenticated Kortix route |
| Carries a Kortix token | yes, on every request | **never** — it mints and refreshes one, and calls nothing with it |
| Number of instances | one path, always | zero or more; a host may use a PAT instead and never construct it |
| Imported by the core | yes (`core/http/auth.ts`) | no — nothing in the SDK imports it; the host wires it |

Concretely, the whole module's outbound traffic is:

- `GET {backendUrl}/auth/config` — **unauthenticated**, no `Authorization`
  header ever set.
- `POST/GET {gotrueUrl}/auth/v1/…` — GoTrue, authorized by the public anon key,
  never by a Kortix token.

It never calls `authenticatedFetch`, never calls `backendApi`, never resolves a
session runtime, and never sets `platformConfig()`. The forbidden thing — a code
path that reaches a Kortix API route with a credential that did not come through
`getToken` — does not exist here.

The `session_id == sandbox_id` and session-scoping invariants are untouched:
this module knows nothing about sessions.

### 1.2 Proposed `AGENTS.md` wording update

Replace `packages/sdk/AGENTS.md:67-71` with:

> **Auth is exactly one seam:** `getToken`. It returns a Kortix PAT
> (`kortix_pat_…`), a service-account key (`kortix_sa_…`), or a Supabase JWT for
> a logged-in web user. Everything else — REST calls and the proxied runtime
> alike — flows through `authenticatedFetch`, which attaches it. There is no
> second auth path. Do not add one.
>
> **`createKortixAuth` does not add one.** It is a token *producer* that sits in
> front of the seam: it signs a user in against the deployment's GoTrue and
> returns a `getToken` you hand to `createKortix`. It never calls an
> authenticated Kortix route, never touches `authenticatedFetch`, and never
> reaches the session runtime. Exactly one unauthenticated Kortix call —
> `GET /v1/auth/config` — tells it which GoTrue to talk to. A new *producer* of
> `getToken` is fine; a request path that carries a credential without going
> through `getToken` is the forbidden second seam.

And add one line to the layers diagram at `AGENTS.md:75-83`, above
`platform/auth + platform/api-client`:

```
core/auth (createKortixAuth)          ← optional token PRODUCER. Feeds getToken. Calls no authed Kortix route.
```

---

## 2. API route contract

### 2.1 Path, method, auth

```
GET /v1/auth/config
```

**Unauthenticated.** No `Authorization` header is read. The response is
byte-identical with and without one — pinned by test (§6.2). Nothing in the body
varies per caller, per account, or per tenant.

### 2.2 Response — `200 application/json`

```jsonc
{
  "provider": "supabase",
  "url": "https://supa.kortix.com",
  "anon_key": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "methods": ["magic", "password"],
  "providers": ["google"],
  "signups_enabled": true
}
```

zod schema (`apps/api/src/auth/config-route.ts`):

```ts
const AuthConfigSchema = z.object({
  provider: z.literal('supabase'),
  url: z.string().url(),
  anon_key: z.string().min(1),
  methods: z.array(z.enum(['magic', 'password'])),
  providers: z.array(z.string()),
  signups_enabled: z.boolean(),
});
```

snake_case, matching the neighbouring auth route
(`{ok, revoked_session_rows}` — `apps/api/src/auth/index.ts:44`). The SDK maps to
camelCase at its boundary.

| Field | Source | Rule |
|---|---|---|
| `provider` | constant | Literal `'supabase'`. A union member, so a future provider is additive and an old SDK can refuse an unknown value instead of guessing. |
| `url` | `config.SUPABASE_PUBLIC_URL \|\| config.SUPABASE_URL` | The **browser-reachable** GoTrue **origin**, no `/auth/v1` suffix, no trailing slash. `SUPABASE_PUBLIC_URL` wins because `SUPABASE_URL` is an internal Docker hostname in self-host (`apps/api/src/config.ts:129-134`). |
| `anon_key` | `config.SUPABASE_ANON_KEY` (**new**) | The publishable key. See §2.5. |
| `methods` | `AUTH_METHODS` | Comma-separated, trimmed, lowercased, filtered to `magic`/`password`; empty or absent → `['magic','password']`. Identical rule to `parseAuthMethods` (`apps/web/src/lib/auth/unified-auth-flow.ts:34-40`) — port it, do not re-derive it. |
| `providers` | `AUTH_PROVIDERS` | Comma-separated, trimmed, lowercased, empties dropped, deduped; absent → `[]`. Same parse as `apps/web/src/app/(auth)/auth/page.tsx:169-175`. |
| `signups_enabled` | `areSignupsEnabled()` | Reuse the existing helper behind `GET /v1/access/signup-status` (`apps/api/src/access-control/index.ts:33-41`). No DB read. |

### 2.3 Errors

| Status | Body `error` code | When |
|---|---|---|
| `503` | `auth_config_unavailable` | `SUPABASE_ANON_KEY` unset, **or** the resolved `url` is not browser-reachable. |

"Not browser-reachable" is a real failure, not a nicety: in self-host,
`kortix-api` sees `SUPABASE_URL=http://supabase-kong:8000`
(`apps/cli/src/self-host/assets/kortix-compose.yml:60`) — a hostname no browser
can resolve. If `SUPABASE_PUBLIC_URL` is empty there, handing that value out
produces a client that fails with an opaque network error on every sign-in.
**Fail loud at the source instead.** The rule: when `SUPABASE_PUBLIC_URL` is
empty and `SUPABASE_URL`'s hostname has no dot and is not `localhost` /
`127.0.0.1` (i.e. a bare container name), return `503`. Standard error envelope
(`ErrorSchema` from `apps/api/src/openapi/index.ts:15`), so `...errors(503)`.

### 2.4 Cache headers

```
Cache-Control: public, max-age=60, must-revalidate
ETag: "<sha256 of the serialized payload, first 16 hex>"
```

`If-None-Match` matching the current ETag → `304` with an empty body. Same
mechanism as `GET /v1/system/maintenance` (`apps/api/src/index.ts:634-650`,
`computeEtag`/`etagMatches`), with `max-age=60` instead of `5`: this payload
changes only on deploy, whereas maintenance is an emergency kill switch.

`public` is safe **because** the response never varies per caller — that is the
same reason maintenance uses it, and it is why §6.2 pins the
identical-with-and-without-a-token assertion. No `Vary: Authorization`; adding
one would be an admission that the payload varies, which it must not.

**No rate limit.** `/access/check-email` is rate-limited because it is an oracle
about *other people's* accounts; this route is a static, cacheable,
already-public constant. ETag + `max-age` is the load control. A rate limit here
would only break cold starts behind a shared NAT.

### 2.5 Is serving the anon key safe?

Yes, and the reason is checkable rather than a judgement call: `apps/web` already
serves the same value to every browser that loads the app
(`apps/web/src/lib/env-config.ts:29`, `apps/cli/src/self-host/assets/
kortix-compose.yml:13`), and every GoTrue request from that browser sends it as
an `apikey` header. It is the *publishable* key; it grants nothing beyond the
anonymous role and is what GoTrue's own client requires. Row-level security and
`apps/api`'s JWKS verification (`apps/api/src/shared/jwt-verify.ts:45`) are the
actual controls.

`SUPABASE_SERVICE_ROLE_KEY` must never appear in this response. §6.2 pins that
as an explicit negative assertion, not an assumption.

### 2.6 Where it mounts, and the trap

`apps/api/src/auth/index.ts:25` is `authRouter.use('/*', supabaseAuth)`. Every
route on that router is gated. The new route must not be.

**Mount a separate public router, and prove the ordering.**

```ts
// apps/api/src/auth/config-route.ts
export const authConfigRouter = makeOpenApiApp<AppEnv>();   // no supabaseAuth
```

```ts
// apps/api/src/index.ts — BEFORE the existing line 812
app.route('/v1/auth', authConfigRouter);   // GET /v1/auth/config — public
app.route('/v1/auth', authRouter);         // POST /v1/auth/logout — supabaseAuth
```

Hono matches handlers in registration order, so the public handler answers and
returns before `authRouter`'s `use('/*')` is ever composed. That is correct and
it is fragile: one reordering silently either gates `/config` or un-gates
`/logout`. The ordering is therefore **pinned by a test that asserts both halves
in the same app instance** (§6.2) — the test is the guard, the comment is not.

Rejected alternatives:

- Narrowing `authRouter.use('/*')` to `use('/logout')`. Makes future routes on
  that router unauthenticated **by default**. Refused: security controls default
  to enforce.
- Hanging it off `/v1/access` (already a public router). Correct-by-construction,
  but `/v1/auth/config` is the name a consumer will look for, and the discovery
  payload is auth config, not access control.

### 2.7 CORS

`apps/api/src/middleware/cors.ts:29-42` is an allowlist (`CLOUD_ORIGINS` +
`LOCAL_ORIGINS` + `CORS_ALLOWED_ORIGINS`). A browser app on an arbitrary origin
gets no CORS headers.

This does not block the feature and must not be silently widened:

- **Node, Bun, Workers, RN, Electron, CLI hosts** — no CORS, works today.
- **Browser hosts** — the discovery call is blocked by the same allowlist that
  already blocks every other `@kortix/sdk` call from that origin. Discovery is
  not the constraint; the deployment operator adding the origin to
  `CORS_ALLOWED_ORIGINS` is, and that is the existing, correct control.

**Open decision (needs Jay):** give this one route
`Access-Control-Allow-Origin: *`. The payload is public, credential-free, and
cache-safe, so it is defensible — but it would let an arbitrary origin discover a
deployment's GoTrue and drive sign-in against it directly, with only the Kortix
API's allowlist stopping the resulting token from being useful. **Default in this
spec: no change to CORS.** Revisit as a separate decision with its own threat
note; do not fold it into this change.

### 2.8 Old-API degradation

An SDK newer than the deployment gets `404`. `fetchKortixAuthConfig` maps that to
`KortixAuthError { code: 'auth_config_unsupported', status: 404 }` whose message
names the route and the required platform version, instead of a generic parse
failure. Pinned by test.

---

## 3. SDK module design

### 3.1 File placement — isomorphic core, root barrel, **no new subpath**

Every file is `isomorphic-core` tier: no `react`, `react-dom`, `next`, `zustand`,
`@tanstack/react-query`, no `'use client'`, no `node:` import, and no bare
global read.

```
packages/sdk/src/core/auth/
  config.ts       fetchKortixAuthConfig — the one unauthenticated Kortix call
  gotrue.ts       pure GoTrue REST calls over an injected fetch; no state
  session.ts      KortixAuthSession/User types + JWT exp decoding
  storage.ts      KortixAuthStorage + localStorage/in-memory adapters
  errors.ts       KortixAuthError
  client.ts       createKortixAuth — cache, single-flight, refresh, listeners
  index.ts        barrel
  *.test.ts       colocated, one per file
```

`src/index.ts` gains one explicit re-export block. **No changes to
`package.json` → `exports`, `publishConfig.exports`, or `SUBPATH_TIERS`.**

That is deliberate. `AGENTS.md` requires three synchronized edits for a new
subpath, and `AGENTS.md`'s own standing advice is that surface you never shipped
is surface you never have to support. This module is framework-free and reaches
consumers through the canonical root entry, exactly like `core/files` and
`core/turns`. A subpath would buy nothing and cost a permanent public path.

**Where a subpath would become unavoidable** (not in v1): a React
`useKortixAuth()` hook, which belongs in the existing `./react` subpath, or a
Node-only cookie/SSR adapter, which belongs in the existing `./server`. Neither
needs a *new* key.

### 3.2 Public surface (all additive)

```ts
export function createKortixAuth(options: KortixAuthOptions): KortixAuth;
export function fetchKortixAuthConfig(options: { backendUrl: string; fetch?: typeof fetch; signal?: AbortSignal }): Promise<KortixAuthConfig>;
export function createMemoryAuthStorage(): KortixAuthStorage;
export function createLocalStorageAuthStorage(): KortixAuthStorage | null;   // null when unavailable
export class KortixAuthError extends Error { status: number; code: string | null; body: unknown }

export type KortixAuthOptions;
export type KortixAuth;
export type KortixAuthConfig;
export type KortixAuthSession;
export type KortixAuthUser;
export type KortixAuthStorage;
export type KortixAuthEvent;
export type KortixAuthChange;
export type KortixAuthMethod;
export type KortixVerifyOtpType;
```

**Naming.** `AuthError` is already taken — it is the REST `401` class exported
from `core/http/api/errors` (`src/index.ts:136`) and it is in the committed
public snapshot. Renaming it would break every consumer. `KortixAuthError` is
therefore a case where the `Kortix` prefix earns its keep, exactly as
`AGENTS.md:194-202` describes. Every other new name is unprefixed and globally
unique; the single root barrel makes a collision a `TS2308` build error.

### 3.3 `KortixAuth`

```ts
interface KortixAuth {
  /** The seam. Never throws; null means "no usable token". */
  getToken(): Promise<string | null>;

  signInWithPassword(input: { email: string; password: string }): Promise<KortixAuthSession>;

  /** Sends the email. Resolves void — no session exists yet. */
  signInWithOtp(input: {
    email: string;
    redirectTo?: string;
    shouldCreateUser?: boolean;      // default true, matching GoTrue
    data?: Record<string, unknown>;
  }): Promise<void>;

  verifyOtp(input: {
    email: string;
    token: string;
    type?: KortixVerifyOtpType;      // default 'email'
  }): Promise<KortixAuthSession>;

  signOut(options?: { scope?: 'global' | 'local' | 'others' }): Promise<void>;

  /** Live read from GoTrue. Cached with the session; `force` re-reads. */
  getUser(options?: { force?: boolean }): Promise<KortixAuthUser | null>;

  /** Force a refresh regardless of TTL. Null when there is nothing to refresh. */
  refresh(): Promise<KortixAuthSession | null>;

  onChange(listener: (change: KortixAuthChange) => void): () => void;

  // Beyond the brief, each earning its place:
  /** Synchronous read of in-memory state. A host cannot render an auth gate off a Promise. */
  getSession(): KortixAuthSession | null;
  /** The memoized discovery result — hosts need `methods`/`providers` to render a login form. */
  config(): Promise<KortixAuthConfig>;
  /** PKCE social sign-in, §3.8. */
  authorizeUrl(provider: string, options?: { redirectTo?: string; scopes?: string }): Promise<string>;
  exchangeCodeForSession(code: string): Promise<KortixAuthSession>;
}
```

`getToken` is an **arrow-function property**, not a prototype method, so
`createKortix({ getToken: auth.getToken })` works unbound. Pinned by test —
this is the single most likely first-use failure.

```ts
interface KortixAuthOptions {
  backendUrl: string;
  /** Skip discovery entirely (self-host with known values, or a test). */
  config?: KortixAuthConfig;
  storage?: KortixAuthStorage;
  storageKey?: string;             // default 'kortix.auth.session'
  fetch?: typeof fetch;
  /** Seconds before `exp` a token counts as expired. Default 30. */
  expirySkewSeconds?: number;
  /** In-memory reuse window. Default 30_000, from apps/web. */
  tokenCacheTtlMs?: number;
  onError?: (error: unknown, context?: unknown) => void;
  /** Browser-only, opt-in. Default false. §3.7. */
  syncAcrossTabs?: boolean;
}
```

### 3.4 GoTrue endpoints — mirrored exactly

Verified against `@supabase/auth-js@2.110.0`
(`node_modules/.pnpm/@supabase+auth-js@2.110.0/…/dist/module/GoTrueClient.js`)
and against what the repo already exercises
(`tests/src/fixtures/supabase.ts:30`, `apps/web/src/lib/supabase/client.ts:34`).
Every request sends `apikey: <anon_key>` and `Content-Type: application/json`.

| SDK method | GoTrue call | Evidence |
|---|---|---|
| `signInWithPassword` | `POST {url}/auth/v1/token?grant_type=password` `{email,password}` | `GoTrueClient.js:885`; `tests/src/fixtures/supabase.ts:30` |
| `signInWithOtp` | `POST {url}/auth/v1/otp` `{email,data,create_user,gotrue_meta_security}` + `?redirect_to=` | `GoTrueClient.js:1783` |
| `verifyOtp` | `POST {url}/auth/v1/verify` `{email,token,type,gotrue_meta_security}` — see the amendment in §9 | `GoTrueClient.js:1970` |
| `refresh` | `POST {url}/auth/v1/token?grant_type=refresh_token` `{refresh_token}` | `GoTrueClient.js:3907` |
| `signOut` | `POST {url}/auth/v1/logout?scope=global` + `Authorization: Bearer` | `GoTrueAdminApi.js:70` |
| `getUser` | `GET {url}/auth/v1/user` + `Authorization: Bearer` | `GoTrueClient.js:2611` |
| `authorizeUrl` | `GET {url}/auth/v1/authorize?provider=…&redirect_to=…` (URL only) | `GoTrueClient.js:3940` |
| `exchangeCodeForSession` | `POST {url}/auth/v1/token?grant_type=pkce` `{auth_code,code_verifier}` | `GoTrueClient.js:1549` |

`gotrue.ts` holds no state: every function takes `{ url, anonKey, fetch }`
explicitly, which is what makes it directly unit-testable against an injected
`fetch` without constructing a client.

**Error mapping.** A non-2xx becomes `KortixAuthError` with `.status`, `.code`
(GoTrue's `error_code`, else `error`, else `null`), `.body` (parsed), and a
message from `error_description` → `msg` → `error` → `statusText`. Callers
branch on `.code` (`invalid_credentials`, `otp_expired`, `email_not_confirmed`,
`invalid_grant`, `over_email_send_rate_limit`), which is why `.code` is a
first-class field and not buried in `.body`.

### 3.5 `getToken` — the semantics absorbed from `apps/web`

A behaviour-preserving port of `apps/web/src/lib/auth-token.ts`, with its own
documented fix kept.

Constants, carried across verbatim (`auth-token.ts:26-34`):
`TOKEN_CACHE_TTL = 30_000`, `TOKEN_MAX_RETRIES = 2`,
`TOKEN_RETRY_BASE_DELAY = 300`, expiry skew `30` s.

1. **Fast path.** In-memory token, `now - cachedAt < tokenCacheTtlMs`, and not
   within `expirySkewSeconds` of `exp` → return it. Zero I/O.
2. **Single flight.** A module-instance `inflight: Promise<string|null> | null`.
   Concurrent callers piggyback; cleared in `finally`. Five concurrent
   `getToken()` on a cold cache produce **one** network request — the assertion
   in §6.1.
3. **Read storage.** Hydrate the persisted session. A valid, un-expired
   `access_token` is adopted and returned.
4. **Refresh.** Expired-or-near-expiry with a `refresh_token` →
   `grant_type=refresh_token`. Persist, emit `TOKEN_REFRESHED`, return.
   *This is the fix:* the old naive path returned the stored-but-dead token and
   only refreshed when the session was entirely null
   (`auth-token.ts:164-177`). Reproduced as a test, not just a comment.
5. **Server said no** (`400`/`401`, e.g. `invalid_grant`,
   `refresh_token_not_found`) → clear storage and memory, emit `SIGNED_OUT`,
   return `null`.
6. **Network said nothing** (fetch threw, `5xx`) → retry twice at `300`/`600` ms.
   Still failing → return the last-known token if it is not yet past `exp`, else
   `null`. **Server rejection and network failure are handled differently on
   purpose**: a flaky network must not sign a user out.
7. **`getToken` never throws.** It is the seam `authenticatedFetch` calls;
   `authenticatedFetch` already converts `null` into a synthetic `401`
   (`core/http/auth.ts:176-178`), which is the correct, already-handled shape.
   Errors go to `onError`.

**No timers.** Refresh is lazy, driven by `getToken`. Nothing is scheduled at
construction — so the module is inert in a Worker, a Lambda, and a test, and
there is no `dispose()` to forget to call. Asserted by a test that no
`setInterval`/`setTimeout` is created on construction.

### 3.6 Storage contract

```ts
interface KortixAuthStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}
```

Async-tolerant by design (every call site `await`s), so React Native
`AsyncStorage` and Expo `SecureStore` drop in with no adapter.

Default resolution:

1. `options.storage`, when given.
2. `localStorage`, **probed** — write/read/remove a throwaway key inside
   `try/catch`. Safari private mode and a quota-full origin *throw* on
   `setItem`; `typeof localStorage !== 'undefined'` does not catch that. Guarded
   global access per the tripwire's documented blind spot
   (`AGENTS.md:285-301`).
3. In-memory `Map`. Sessions do not survive a reload — correct and honest for a
   Worker or a locked-down browser.

Persisted blob, versioned:

```jsonc
{
  "v": 1,
  "url": "https://supa.kortix.com",
  "session": { "access_token": "…", "refresh_token": "…", "expires_at": 1770000000,
               "token_type": "bearer", "user": { "id": "…", "email": "…" } }
}
```

`url` is stored **and checked**. A blob whose `url` differs from the discovered
one is discarded. That makes the classic footgun — one browser profile used
against `dev-api` and `api`, sharing `localStorage`, cross-feeding tokens —
structurally impossible without inventing a key-hashing scheme. A malformed or
wrong-`v` blob is discarded silently and treated as signed out; a corrupt cache
must never throw on read.

### 3.7 `onChange`

```ts
type KortixAuthEvent = 'INITIAL' | 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED' | 'USER_UPDATED';
interface KortixAuthChange { event: KortixAuthEvent; session: KortixAuthSession | null }
```

Names mirror GoTrue's `onAuthStateChange` on purpose: a host migrating off
supabase-js (`apps/web/src/features/providers/auth-provider.tsx:82-120` is the
reference consumer) keeps its `switch` unchanged.

- `onChange(l)` returns an unsubscribe function.
- `INITIAL` is delivered once per listener on a microtask with the current
  hydrated session (or `null`), so a host never has to special-case "before
  first event".
- A listener that throws is caught and routed to `onError`. One bad listener
  must not break token refresh for everything else.
- **Cross-tab is opt-in.** `syncAcrossTabs: true` subscribes to the `storage`
  event behind `typeof window !== 'undefined' && typeof addEventListener === 'function'`.
  Default `false`, because the core may never touch a bare global and a Worker
  has no `window`. No `BroadcastChannel` in v1.

### 3.8 Social sign-in — PKCE only

`authorizeUrl(provider, { redirectTo })`:

1. Generate a 64-char verifier from `crypto.getRandomValues`.
2. `code_challenge = base64url(SHA-256(verifier))` via `crypto.subtle.digest`.
3. Persist the verifier under `<storageKey>.verifier`.
4. Return `{url}/auth/v1/authorize?provider=…&redirect_to=…&code_challenge=…&code_challenge_method=S256`.

`exchangeCodeForSession(code)` reads the verifier, posts `grant_type=pkce`,
persists the session, emits `SIGNED_IN`, and clears the verifier.

**No `plain` fallback.** GoTrue accepts `code_challenge_method=plain`, and
falling back to it silently downgrades the flow. When `globalThis.crypto?.subtle`
is absent (Hermes/React Native without a polyfill), `authorizeUrl` throws
`KortixAuthError { code: 'pkce_unsupported' }` naming the missing API. Loud
failure over a silent downgrade.

The SDK builds the URL and exchanges the code. It does **not** navigate, open a
popup, register a deep-link handler, parse a callback URL, or read an
implicit-flow fragment. See §5.

### 3.9 Wiring

```ts
import { createKortix, createKortixAuth } from '@kortix/sdk';

const backendUrl = 'https://api.kortix.com/v1';
const auth = createKortixAuth({ backendUrl });
const kortix = createKortix({ backendUrl, getToken: auth.getToken });

await auth.signInWithPassword({ email, password });
await kortix.projects.list();
```

Two objects, one seam, one client. `createKortixAuth` does not call
`configureKortix` — that would make constructing it a global side effect and
break `createScopedKortix`'s per-request isolation (`core/http/config.ts:98-110`).

Existing surface is untouched: `kortix.auth.*` (access check, `logout` audit,
`accountState`, OAuth consent, identity binds, deletion —
`core/client/kortix.ts:466-506`) keeps its meaning. Those are *Kortix* auth
routes reached with a token; this module *produces* the token. A host that wants
the server-side audit trail on sign-out calls both, in the order the docs show:
`await kortix.auth.logout()` then `await auth.signOut()`.

---

## 4. Deployment prerequisite — `SUPABASE_ANON_KEY` is missing

Verified in this worktree:

```
$ for f in apps/api/.env apps/api/.env.dev apps/api/.env.staging apps/api/.env.prod; do
    echo "$f: $(grep -o '^[A-Z_]*ANON[A-Z_]*' $f | tr '\n' ' ')"; done
apps/api/.env:
apps/api/.env.dev:
apps/api/.env.staging: SUPABASE_ANON_KEY
apps/api/.env.prod:
```

`apps/api/src/config.ts` has no `SUPABASE_ANON_KEY` entry at all. So:

1. Add it to the config schema as **optional** (`optStr()`), and to the exported
   config object beside `SUPABASE_PUBLIC_URL` (`config.ts:950-952`). Optional,
   not required — a missing key must degrade to a `503` on one route, never fail
   API startup for every deployment that has not been updated yet.
2. Set it per environment with dotenvx — never a plaintext commit:
   `dotenvx set SUPABASE_ANON_KEY <value> -f apps/api/.env` (and `.env.dev`,
   `.env.prod`), then commit the ciphertext. Prod additionally needs the
   `kortix-prod-env` secret sync (≈1 h propagation).
3. **Self-host needs no change**: `kortix-api` already loads `env_file: .env`
   (`kortix-compose.yml:57`) and `SUPABASE_ANON_KEY` already lists `kortix-api`
   as a consumer (`apps/cli/src/self-host/secrets-registry.ts:231`).

Until step 2 lands per environment, `/v1/auth/config` returns `503
auth_config_unavailable` there. That is the designed behaviour, and it is why the
ke2e flow asserts a real password grant against the returned values rather than
just a `200`.

---

## 5. Non-goals

Explicit, so a reviewer knows these are decisions and not omissions.

1. **MFA / TOTP.** `/auth/v1/factors/*` is not wrapped, not typed, not exported.
   A deployment with MFA enforced returns a partial session GoTrue expects the
   client to complete; v1 surfaces the raw error and does not model AAL.
2. **SAML / SSO sign-in.** No `/auth/v1/sso`, no IdP redirect, no
   `saml_enabled` probe. The `apps/web` SSO interstitial
   (`auth/page.tsx`, `sso-entry.test.ts`) stays host-side.
3. **OAuth-social redirect handling.** The SDK builds a PKCE authorize URL and
   exchanges a code (§3.8). It does **not** navigate or `window.open`, register a
   deep link or universal link, parse a callback URL or query string, or read an
   implicit-flow `#access_token=` fragment (refused outright — that flow leaks
   tokens into history and referrers).
4. **`apps/web` cutover.** `apps/web` keeps `@supabase/ssr`,
   `lib/supabase/client.ts`, `lib/auth-token.ts`, its server actions, and its
   middleware. Its sessions are **cookie**-backed for SSR; this module is
   `localStorage`/in-memory only. The cutover is a separate spec with its own
   risk surface, and it is not a prerequisite for shipping this.
5. **Cookie / SSR session storage**, `@supabase/ssr` parity, and Next.js
   middleware integration.
6. **Password lifecycle beyond sign-in**: `signUp` with password,
   `resetPasswordForEmail`, `updateUser`, `resend`, email-change confirmation.
7. **Phone/SMS OTP, anonymous sign-in, Web3, passkeys, identity linking.**
8. **A React hook.** `@kortix/sdk/react` is untouched in v1. `useKortixAuth`
   would go in the existing `./react` subpath later; nothing here blocks it.
9. **Server-side token verification.** `apps/api` already verifies JWTs locally
   via JWKS (`apps/api/src/shared/jwt-verify.ts:45`). Unchanged.
10. **Widening CORS** (§2.7) — a separate decision.
11. **Cross-tab sync on by default** — opt-in only (§3.7).

---

## 6. Test plan

TDD is mandatory in `packages/sdk` (`AGENTS.md:13-15`): failing test first, watch
it fail for the right reason, then implement. Every task below is RED → GREEN →
REFACTOR.

Before starting, re-derive the session baseline — the number in `AGENTS.md`
drifts and the most recent `PROGRESS.md` entry records `2337 pass`:

```bash
pnpm --filter @kortix/sdk test 2>&1 | tail -3
```

### 6.1 `packages/sdk` unit tests (colocated, `bun test`)

**`core/auth/config.test.ts`**
- `https://api.kortix.com` and `https://api.kortix.com/v1` both request
  `…/v1/auth/config` (the `apiBase` rule from
  `core/rest/platform-client/host-boundary.ts:32-36`).
- No `Authorization` header on the request, ever.
- `200` → typed `KortixAuthConfig`; trailing slash stripped from `url`.
- `503` → `KortixAuthError` with `.status === 503`, `.code === 'auth_config_unavailable'`.
- `404` → `.code === 'auth_config_unsupported'`, message names the route.
- `provider: 'okta'` → typed error, not a silent guess.
- Memoized: two `config()` calls → one fetch; `config` supplied in options → zero fetches.

**`core/auth/session.test.ts`**
- `isJwtExpired` honours the 30 s skew.
- Unparseable payload → `false` (use it, let the server judge —
  `apps/web/src/lib/auth-token.ts:134-149`).
- Missing/non-numeric `exp` → `false`.
- base64url `-`/`_` decoded correctly.

**`core/auth/storage.test.ts`**
- Probe succeeds → `localStorage` adapter chosen.
- Probe `setItem` **throws** → memory adapter, no exception escapes.
- No `localStorage` global → memory adapter.
- Async adapter (`AsyncStorage` shape) is awaited on read and write.
- Blob with `v: 0` → discarded.
- Blob whose `url` ≠ discovered `url` → discarded (cross-backend contamination).
- Non-JSON blob → discarded, no throw.

**`core/auth/gotrue.test.ts`** — one test per endpoint in §3.4, against an
injected `fetch`: exact method, exact path incl. query, `apikey` header present,
`Authorization: Bearer` present only on `logout`/`user`, exact body keys. Plus
error mapping: `error_description` → `.message`, `error_code` → `.code`,
`.status` preserved, non-JSON body tolerated.

**`core/auth/client.test.ts`** — the behavioural core:

| Assertion | Why it exists |
|---|---|
| Second `getToken()` inside 30 s → **0** additional fetches | the cache |
| 5 concurrent `getToken()` cold → **exactly 1** refresh request | single flight |
| Stored-but-expired `access_token` → refreshed, expired token never returned | the `auth-token.ts:164-177` bug |
| Refresh `400 invalid_grant` → storage cleared, `SIGNED_OUT`, `getToken()` → `null`, **no throw** | server said no |
| Refresh network error → 2 retries at 300/600 ms (fake timers), then last-known un-expired token | network said nothing ≠ signed out |
| `signInWithPassword` → persisted, `SIGNED_IN`, next `getToken()` does no I/O | happy path |
| `signInWithOtp` → resolves `void`, `redirect_to` in the query, `create_user` default `true` | matches GoTrue |
| `verifyOtp` → session persisted, `SIGNED_IN` | |
| `signOut()` with the GoTrue call **failing** → local state still cleared, `SIGNED_OUT` still emitted | sign-out must never strand a session |
| `onChange` unsubscribe stops delivery; a throwing listener does not break refresh | emitter hygiene |
| `INITIAL` delivered once per listener with the hydrated session | no "before first event" case |
| `createKortix({ getToken: auth.getToken })` with the bare method works | bound-method pin |
| No `setTimeout`/`setInterval` at construction | no timers |
| `authorizeUrl` with no `crypto.subtle` → `code: 'pkce_unsupported'` | no silent downgrade |
| `authorizeUrl` → `code_challenge_method=S256`, verifier persisted; `exchangeCodeForSession` sends it and clears it | PKCE round trip |

**`src/index.isomorphic.test.ts`** — must stay green unchanged (`core/auth/**` is
reachable from the root `.` entry, so the existing walk already covers it). Add
one new assertion in the same file: a regex scan over `core/auth/**` rejecting an
unguarded `localStorage` / `window` / `document` / `process` identifier, because
the tripwire walks imports and **cannot see globals** (`AGENTS.md:284-301`) —
and this is the first core module that legitimately wants one.

**Snapshots** — `public-surface.test.ts` and `public-type-surface.test.ts` go red.
Re-record with `UPDATE_SURFACE_SNAPSHOT=1` **only after reading the diff**, and
only if it is purely additive. A removed or renamed name means stop.

**`examples/10-sign-in-and-run.ts`** — typechecked in CI: discover → sign in →
`createKortix` → `projects.list()`, with the npm import line in the header
comment.

**Gates, output pasted, plus an explicit shippable YES/NO/NOT YET:**

```bash
pnpm --filter @kortix/sdk typecheck
pnpm --filter @kortix/sdk test           # count must be ≥ the session baseline
pnpm --filter @kortix/sdk run smoke:install
```

### 6.2 `apps/api` unit tests — `src/auth/config-route.test.ts`

- `200` body matches `AuthConfigSchema` exactly (no extra keys).
- `SUPABASE_PUBLIC_URL` wins over `SUPABASE_URL`; trailing slash stripped.
- `SUPABASE_PUBLIC_URL` empty + `SUPABASE_URL=http://supabase-kong:8000` → `503
  auth_config_unavailable`.
- `SUPABASE_ANON_KEY` unset → `503`.
- `AUTH_METHODS='password, MAGIC ,junk'` → `['password','magic']`; unset →
  `['magic','password']`.
- `AUTH_PROVIDERS='Google, ,google'` → `['google']`; unset → `[]`.
- **Response identical with and without an `Authorization` header** (byte
  comparison) — the premise `Cache-Control: public` depends on.
- **Body never contains `SUPABASE_SERVICE_ROLE_KEY`'s value** — explicit
  negative assertion.
- ETag stable across two calls; `If-None-Match` → `304` with an empty body.
- **Ordering guard**, same app instance: ANON `GET /v1/auth/config` → `200`
  **and** ANON `POST /v1/auth/logout` → `401`. This one test is what keeps the
  `app.route` order in `apps/api/src/index.ts` honest.

### 6.3 Route manifest

Regenerate with the documented env (`apps/api/scripts/dump-routes.ts:22-26` —
wrong flags silently rewrite the manifest and move the coverage gate):

```bash
cd apps/api && SUPABASE_URL=https://placeholder.supabase.co \
  INTERNAL_KORTIX_ENV=dev KORTIX_BILLING_INTERNAL_ENABLED=true \
  LLM_GATEWAY_ENABLED=true bun scripts/dump-routes.ts
```

Expected diff: exactly one added entry `{ "method": "GET", "path":
"/v1/auth/config" }`, and `count` `592` → `593`. Any other delta means the env
was wrong — revert and redo.

### 6.4 ke2e flow

**`tests/spec/end-to-end.md`** — new contract beside `AUTH-1` (line 113 block):

> `AUTH-3` `GET /v1/auth/config` → 200 `{provider:'supabase', url, anon_key,
> methods[], providers[], signups_enabled}` for ANON; identical body with a
> bearer token; `If-None-Match` → 304; `POST /v1/auth/logout` stays 401 for ANON.
> The returned `url` + `anon_key` complete a real GoTrue password grant for a
> fixture user, and that token is accepted by `GET /v1/accounts`.

**`tests/src/flows/auth.flow.ts`** — append:

```ts
flow(
  "AUTH-3",
  { domain: "auth", tags: ["smoke"], routes: ["GET /v1/auth/config"] },
  async (ctx) => { /* steps below */ },
);
```

Steps, each a complete action and observable result:

1. `ANON GET /v1/auth/config → 200` with `provider`, `url`, `anon_key`,
   `methods`, `providers`, `signups_enabled`.
2. `OWNER GET /v1/auth/config → 200`, body deep-equals step 1's — proves it does
   not vary per caller.
3. `GET` with `If-None-Match: <etag from step 1>` → `304`.
4. **The step that matters:** `POST {url}/auth/v1/token?grant_type=password` with
   `apikey: <anon_key>` for the fixture user → `200` + `access_token`.
5. `GET /v1/accounts` with that `access_token` → `200`. The discovered values are
   *usable*, not merely present.
6. `ANON POST /v1/auth/logout → 401` — the mount-ordering guard, at the product
   boundary.

`meta.routes` must stay synchronized with `tests/spec/routes.generated.json`;
the route-coverage lane reads both.

Run: `pnpm test -- --id AUTH-3`, then `pnpm test -- --domain auth`, then the full
`pnpm test`.

### 6.5 Documentation

- **`apps/web/content/docs/sdk/auth.mdx`** — new section **"Sign in through the
  SDK"**, placed between "Supabase JWT" and "Choose a credential": the
  `createKortixAuth` snippet, the storage + refresh contract, the `onChange`
  event table, and an explicit "what this does not do" list (MFA, SAML,
  redirect handling, cookies/SSR). Add one row to the closing table: *"An app
  that signs its own users in → `createKortixAuth` (a managed Supabase JWT)"*.
  This is an existing page, so **no docs timestamp-manifest entry is needed** —
  that requirement applies only to a new page.
- **`packages/sdk/README.md`** and **`GETTING-STARTED.md`** — one snippet each.
- **`packages/sdk/AGENTS.md`** — the §1.2 amendment and the layers-diagram line.
- **`packages/sdk/PROGRESS.md`** — the claim entry, then a session-log entry with
  the real gate output and an explicit shippable verdict.

### 6.6 Delivery

Per the repo standard: dedicated branch in this worktree → local gates green →
push → PR into `main` → required checks → merge → follow **Deploy Dev** to
completion and confirm the deployed artifact carries the merge SHA → re-verify on
dev:

```bash
curl -s https://dev-api.kortix.com/v1/auth/config | jq
# then, with the url + anon_key it returns, a real password grant, then:
curl -s -H "Authorization: Bearer $ACCESS_TOKEN" https://dev-api.kortix.com/v1/accounts
```

Local pass and dev pass are both required. Record PR, merge SHA, deploy run,
deployed-SHA evidence, and the exact dev commands in the final response.

---

## 7. Task chain

| # | Task | Deliverable |
|---|---|---|
| 1 | `apps/api` config key + route | `SUPABASE_ANON_KEY` in `config.ts`; `src/auth/config-route.ts`; mount before `authRouter`; `config-route.test.ts` incl. the ordering guard |
| 2 | Route manifest | `routes.generated.json` regenerated with the documented env |
| 3 | SDK discovery + types | `core/auth/{config,session,errors}.ts` + tests |
| 4 | SDK GoTrue + storage | `core/auth/{gotrue,storage}.ts` + tests |
| 5 | `createKortixAuth` | `core/auth/client.ts` + `client.test.ts`; root-barrel exports; snapshots re-recorded (additive-only) |
| 6 | PKCE social | `authorizeUrl` + `exchangeCodeForSession` + tests |
| 7 | ke2e flow | `AUTH-3` in `end-to-end.md` + `auth.flow.ts` |
| 8 | Docs + `AGENTS.md` + example | `auth.mdx` section, README/GETTING-STARTED, `AGENTS.md` amendment, `examples/10-*.ts` |
| 9 | Secrets + delivery | `dotenvx set` per environment, PR, merge, Deploy Dev, dev verification |

## 8. Open decisions

| Question | Owner | Default in this spec |
|---|---|---|
| `Access-Control-Allow-Origin: *` on `/v1/auth/config` only (§2.7) | Jay | **No change to CORS.** Browser hosts on non-allowlisted origins are already blocked for every other SDK call. |
| Include `sso_enabled` in the payload | Jay | **No.** It needs a per-request upstream hop to GoTrue `/settings` on a public unauthenticated route. The SDK can read `/auth/v1/settings` itself once it holds `url` + `anon_key` (`apps/web/src/lib/supabase/client.ts:34` does exactly that). |
| `createKortixAuth` in `apps/mobile` | Jay | Out of v1. Sign-in itself works on RN (plain `fetch` + JSON); PKCE needs a `crypto.subtle` polyfill and throws loudly without one. SDK **streaming** still does not work on RN (`AGENTS.md:404`) — unchanged by this. |

---

## 9. Amendment 2026-08-19 — `verifyOtp` could not consume what the OTP email carries

Found in live e2e against GoTrue v2.194.0, after §3.4 was implemented as written.

**The defect.** §3.4 specifies exactly one `/auth/v1/verify` body,
`{email, token, type, gotrue_meta_security}`, and §3.3 types the input as
`{ email, token, type? }`. That is the **6-digit-code** form. It only exists if
the deployment's email template renders `{{ .Token }}`. Neither the stock GoTrue
template nor Kortix's own
(`apps/api/src/auth/send-email-hook/templates.ts`) does — both send a **link
only**:

```
/auth/v1/verify?token=<56-hex-hash>&type=magiclink
```

That `token` query parameter is a hash, not a code. Measured against
GoTrue v2.194.0:

| Request body | Result |
|---|---|
| `{ email, token: <56-hex-hash> }` | `403 otp_expired` |
| `{ token_hash: <56-hex-hash>, type }` | `200` + session |

So the shipped `verifyOtp` could not complete the magic-link sign-in that
`signInWithOtp` starts — the only OTP flow a default deployment can produce.

**The fix (additive).** `gotrueVerifyOtp` and `KortixAuth.verifyOtp` now take
`KortixVerifyOtpInput`, a union of exactly two shapes, and send the matching
body — never a mixture, which is the request GoTrue rejects:

| Form | Input | Body sent |
|---|---|---|
| Code | `{ email, token, type? }` (default `'email'`) | `{email,token,type,gotrue_meta_security}` |
| Link | `{ token_hash, type }` (`type` **required**) | `{token_hash,type,gotrue_meta_security}` |

`type` is required in the link form because the link carries it; defaulting it
to `'email'` would reproduce the 403 silently. Session persistence, token
caching, and the `SIGNED_IN` event are the password path's, unchanged and
identical for both forms. Existing `{ email, token }` callers compile and behave
exactly as before.

`KortixVerifyOtpInput` is a new exported type name — additive, so
`public-type-surface.snapshot.json` gains one line and loses none. The union is
gated at compile time: `packages/sdk/tsconfig.json` includes `src/**/*`, so the
four `@ts-expect-error` assertions in `src/core/auth/gotrue.test.ts` fail
`pnpm --filter @kortix/sdk typecheck` the moment the union stops rejecting a
mixed or incomplete shape.

**Standing limitation.** The 6-digit-code form remains unusable on a default
Kortix or stock-GoTrue deployment. Making it work requires an email template
that renders the code, which this amendment deliberately does not change —
`templates.ts` is out of scope here. Documented for consumers in
`apps/web/content/docs/sdk/auth.mdx` → "Completing a magic-link sign-in".
