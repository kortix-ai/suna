# API latency attribution

Every API response carries a `Server-Timing` header. Read it before you
propose a latency fix. It names the layer that spent the time.

## Header format

```text
Server-Timing: total;dur=412, auth;dur=38;desc="n=1", gotrue;dur=35;desc="n=1",
               iam;dur=9;desc="n=4", db;dur=160;desc="n=11", git;dur=0,
               http;dur=0, up;dur=0, api;dur=412
```

| Entry | Meaning | Recorded in |
|---|---|---|
| `total` | Wall time from the timing middleware to the response. | `middleware/upstream-timing.ts` |
| `auth` | Credential verification, impersonation, and the IAM actor build. Ends when the handler starts. | `middleware/auth.ts` |
| `gotrue` | Outbound calls to `<SUPABASE_URL>/auth/…`. | `lib/server-timing.ts` fetch wrapper |
| `iam` | `authorize()` and project-list authorization. Includes the DB queries it issues. | `iam/authorize.ts` |
| `db` | Statements on the request pool, including the wait for a free connection. | `@kortix/db` `onQuery` hook, `shared/db.ts` |
| `git` | `git` processes on the request path (mirror clone, fetch, `ls-tree`, `show`). | `projects/git/mirror.ts` |
| `http` | Every other outbound `fetch` (sandbox daemon, sandbox providers, GitHub, Stripe). Measured to the response headers. | `lib/server-timing.ts` fetch wrapper |
| `up` | Explicit `timeUpstream()` spans (the preview proxy). | `middleware/upstream-timing.ts` |
| `api` | `total` minus `up`. Unchanged since 2026-08-26. | `middleware/upstream-timing.ts` |

Rules for reading it:

1. Each stage is its own wall time: the union of its in-flight intervals. Five
   parallel 20 ms queries report `db;dur=20;desc="n=5"`, not 100.
2. Stages overlap. `iam` contains `db` time. `auth` contains `gotrue` time.
   Do not add stages together.
3. `desc="n=…"` is the operation count. On a high-latency database link, the
   count of sequential round trips predicts latency better than local timing.
4. A stage with no operations is omitted.

## Staging is not a latency proxy for production

Staging ECS runs in `us-west-2`. The staging database runs in `eu-west-2`
(`.github/workflows/deploy-staging.yml`, `REQUEST_DEADLINE_MS` comment). One
round trip costs about 140 ms. Staging also runs `DB_POOL_MAX=4`. A route with
7 sequential queries therefore takes about 1 s on staging and a few ms in
production, where the API and database share `eu-west-2`. Read `db;desc` on
staging, and read absolute durations on production.

## HS256 access tokens and the liveness cache

Production GoTrue signs access tokens with the legacy HS256 secret. The API
verifies them locally when `SUPABASE_JWT_SECRET` is set
(`shared/jwt-verify.ts`). GoTrue still confirms that the session is live, at
most once per token per `SUPABASE_JWT_LIVENESS_TTL_MS` per replica
(`shared/jwt-liveness.ts`).

| Setting | Default | Effect |
|---|---|---|
| `SUPABASE_JWT_SECRET` | unset | Unset: every HS256 request calls GoTrue `getUser` (the old behavior). |
| `SUPABASE_JWT_LIVENESS_TTL_MS` | `30000` | Upper bound on revocation latency for an HS256 token on a replica that already confirmed it. `0` asks GoTrue on every request. |

Security contract:

- A signature, expiry, or subject failure never reaches the cache.
- Only a positive GoTrue answer is cached. A cached answer never outlives the
  token `exp`.
- A secret that does not match GoTrue, or an unreachable GoTrue, falls back to
  the network path. It never accepts the token and never rejects a valid one.
- `POST /v1/auth/logout` and `POST /v1/auth/sign-out` drop the entry on the
  replica that served them. Other replicas re-ask GoTrue within the TTL.
- ES256/RS256 tokens are unchanged: verified locally against the JWKS, with no
  GoTrue call.
