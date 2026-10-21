# Retire the Supabase legacy API keys and the HS256 secret

Closes pentest 2026-07 finding 3. Staging was done on 2026-10-21 with exactly
these steps. Prod waits until the mobile app ships the publishable key.

The legacy `anon` and `service_role` API keys are HS256 JWTs signed by the
legacy JWT secret. Supabase refuses to revoke that secret while they are
enabled. Every hosted project signs user tokens with ES256 since 2026-08-21.

| Project | Ref | Legacy keys | HS256 secret |
|---|---|---|---|
| dev | `heprlhlltebrxydgtsjs` | enabled (dev mobile builds) | `previously_used` |
| staging | `ujzsbwvurfyeuerxxeaz` | disabled 2026-10-21 | revoked 2026-10-21 |
| prod | `jbriwassebxdwoieikga` | enabled until the mobile cutover | `previously_used` |

All calls use the Supabase Management API with a personal access token
(`SUPABASE_MGMT_TOKEN` in `apps/api/.env.local`).

## 1. Wait for legacy traffic to reach zero

Query the edge logs (`GET /v1/projects/<ref>/analytics/endpoints/logs`, `sql` +
`iso_timestamp_start` / `iso_timestamp_end`):

```sql
select substring(log_attributes['request.headers.user_agent'], 1, 40) as ua,
       log_attributes['request.sb.jwt.apikey.payload.role'] as role,
       count() as n, max(timestamp) as last
from logs
where source = 'edge_logs'
  and log_attributes['request.sb.jwt.apikey.payload.algorithm'] = 'HS256'
group by ua, role order by n desc
```

Every row is a client still on a legacy key: `Bun` = an API replica,
`supabase-ssr` = the web app, `okhttp` / `Kortix/<build> CFNetwork` = the
mobile app. Mobile moves with an EAS Update on channel `production` (the
EAS `production` environment holds the publishable key since 2026-10-21).
Builds on an older runtime only move with a store update.

## 2. Disable the legacy API keys (reversible)

```
PUT /v1/projects/<ref>/api-keys/legacy?enabled=false    → {"enabled":false}
```

Propagation takes about 3 minutes. Proof: a legacy key on
`/auth/v1/admin/users` returns 401 `Legacy API keys are disabled`, and the
`sb_secret_` key on the same route returns 200. Undo: `enabled=true`.

## 3. Revoke the HS256 secret

```
GET   /v1/projects/<ref>/config/auth/signing-keys        → the HS256 key id
PATCH /v1/projects/<ref>/config/auth/signing-keys/<id>  {"status":"revoked"}
```

Proof: a token signed with the old secret gets 403 `signing method HS256 is
invalid` from `/auth/v1/user` and 401 from the Kortix API; a real sign-in
still issues an ES256 token that the API accepts. Undo: set the key back to
`standby` (Supabase throttles key changes for about 5 minutes).

## 4. Clean up

`SUPABASE_JWT_SECRET` stays in the env bundles because
`.github/workflows/deploy-staging.yml` requires it. It cannot authenticate
anything after step 3: the API confirms every token with GoTrue
(`apps/api/src/shared/jwt-liveness.ts`), and GoTrue refuses HS256. Self-hosted
Supabase still signs HS256, so the HS256 path in `jwt-verify.ts` stays.
