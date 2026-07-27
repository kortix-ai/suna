# API hot-path latency and request amplification

## Status

Approved by the user on 2026-07-26 for end-to-end implementation and delivery
to `main`.

## Problem

The dev API and dev database run in different AWS regions.

- The API runs on ECS in `us-west-2`.
- Supabase project `heprlhlltebrxydgtsjs` runs in `us-east-2`.
- Each sequential database statement adds a cross-region network round trip.
- The production API and database now both run in `us-east-2`.

The 24-hour dev sample on 2026-07-26 reports:

| Route | Requests | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: |
| `POST /v1/projects/:id/turn-stream` | 24,095 | 1,294 ms | 4,192 ms | 5,419 ms |
| `GET /v1/projects/:id/sessions` | 1,195 | 703 ms | 2,500 ms | 3,487 ms |
| `GET /v1/projects/:id/secrets` | 895 | 1,237 ms | 5,601 ms | 7,112 ms |
| `GET /v1/projects/:id/detail` | 238 | 1,449 ms | 5,176 ms | 6,999 ms |
| `GET /v1/projects/:id/model-picker` | 213 | 448 ms | 1,888 ms | 2,896 ms |

The new `us-east-2` production sample reports ordinary project reads mainly
between 40 ms and 115 ms. This comparison isolates the dev region mismatch.

`turn-stream` also amplifies traffic independent of the region mismatch.

- It is a JSON relay, but OpenAPI declares `text/event-stream`.
- The request-deadline middleware treats it as an unbounded stream.
- The sandbox calls execution-lease discovery during idle startup.
- The sandbox calls discovery after each OpenCode event reconnect.
- A busy sandbox sends a heartbeat every 20 seconds.
- The sandbox touches `/kortix/health` directly before the heartbeat.
- The API resolves the provider and touches `/kortix/health` again.
- The legacy route performs repeated sandbox and session ownership reads.

Generic project authorization also triggers speculative session resumes.

- `loadProjectForUser()` runs on every project route.
- Authorized write-capable reads call `preResumeRecentStoppedSessions()`.
- The selector chooses another stopped historical session after each wake.
- Each ECS process owns an independent 30-second throttle.
- The behavior spends sandbox compute before the user opens a session.

Model and transcript readiness contain independent client waterfalls.

- `useOpenCodeProviders()` waits for project detail before it starts the
  project model-picker request.
- The project model-picker can answer before any sandbox runtime is ready.
- Existing session rows can already contain the authorized OpenCode session
  pin needed for IndexedDB transcript hydration.
- `useSession()` waits for `/start` before it supplies that pin to the sync
  engine.

## Goals

1. Remove idle and reconnect execution-lease requests.
2. Reduce busy lease traffic from one request per 20 seconds to one request per
   60 seconds.
3. Keep at most one pending lease renewal per sandbox.
4. Remove provider network calls from API lease renewal.
5. Keep legacy `turn-stream` lease kinds compatible during sandbox image
   rotation.
6. Move execution leases to a JSON endpoint with a bounded request deadline.
7. Remove speculative resume from generic authorization.
8. Start the project model-picker request without waiting for project detail.
9. Hydrate an existing session transcript before `/start` completes.
10. Keep all caches optional for self-hosted deployments.
11. Add request-count and latency evidence before and after deployment.

## Non-goals

- Redis is not required for correctness.
- Sticky ECS sessions are not required for correctness.
- Authorization revocation does not depend on a distributed cache.
- This change does not move the dev ECS service between AWS regions.
- This change does not alter LLM completion latency inside model providers.
- This change does not recreate retired legacy trigger cron jobs.

## Design

### Execution lease endpoint

Add:

`POST /v1/projects/:projectId/execution-lease`

The route accepts a sandbox token and this body:

```json
{
  "session_id": "uuid",
  "action": "acquire | renew | release",
  "lease_ttl_seconds": 180
}
```

The route returns JSON. It is not a stream.

- `acquire` updates the database lease and resolves the direct provider
  keep-alive endpoint once.
- `renew` performs one conditional database update.
- `release` clears the lease with one conditional database update.
- The update predicates include `sandbox_id`, `session_id`, `project_id`,
  `account_id`, and an allowed sandbox status.
- The API does not call provider `/kortix/health`.

Keep the legacy `turn-stream` execution kinds during image rotation.

- Handle lease kinds before Slack and Teams relay lookups.
- Use the same database operations as the new route.
- Keep legacy discovery available for old reporters.
- Correct the route response content type to JSON.
- Remove `turn-stream` from the request-deadline exemption.

### Sandbox reporter

- Do not discover during idle startup.
- Do not discover on an event-stream reconnect.
- Reconcile OpenCode status on reconnect.
- Acquire the lease only when the first busy session appears.
- Renew every 60 seconds with a 180-second lease.
- Keep one renewal pending at most.
- Touch the direct provider endpoint from the sandbox only.
- Release when the last busy session becomes inactive.

### Session resume

- Remove speculative resume from `loadProjectForUser()`.
- Keep runtime allocation and resume inside explicit session-open paths.
- Do not select a stopped historical session from ordinary project activity.

### Model readiness

- Start `GET /model-picker` in parallel with `GET /detail`.
- Use the model-picker response immediately for gateway projects.
- Preserve the native runtime-provider fallback for non-gateway projects.
- Do not report BYOK provider state as loading after project detail and secrets
  have resolved.

### Transcript readiness

- Add an optional authorized initial OpenCode session pin to `useSession()`.
- Use the initial pin only for local transcript hydration.
- Keep the `/start` response authoritative when it arrives.
- Do not accept an untrusted tenant selector as the initial pin.

### Caching

The first optimization removes duplicate work and serial depth.

Existing IAM memoization remains optional:

- `IAM_CACHE_TTL_MS=0` disables it.
- The default in-memory TTL is 15 seconds.
- No correctness path requires cache affinity.

The runtime model catalog already uses an in-process atomic last-known-good
snapshot. It does not require Redis.

Do not add a token-validation cache in this change. Revocation freshness is
more important than one database read. Re-evaluate distributed caching only
after post-deploy measurements show a remaining stable-read bottleneck.

### Legacy trigger traffic

The old routes are:

- `/api/triggers/:id/webhook`
- `/v1/triggers/:id/webhook`

The prod migration runbook proves that 3,537 legacy PostgreSQL cron jobs called
these removed routes. The latest 24,538 responses were all `404`. The
`us-east-2` production migration intentionally did not recreate these jobs.
No compatibility route is required.

## Verification

1. RED then GREEN unit tests for the sandbox reporter.
2. RED then GREEN API tests for acquire, renew, release, and legacy
   compatibility.
3. A source contract test that forbids speculative resume in authorization.
4. SDK RED then GREEN tests for initial-pin precedence and provider query
   planning.
5. Full API, sandbox daemon, SDK, and web focused gates.
6. Real local authenticated API requests.
7. Chromium assertions for model request ordering and transcript visibility.
8. PR checks and merge to `main`.
9. Deploy Dev workflow completion.
10. Deployed SHA ancestry proof.
11. A new 24-hour or bounded post-deploy CloudWatch sample.

