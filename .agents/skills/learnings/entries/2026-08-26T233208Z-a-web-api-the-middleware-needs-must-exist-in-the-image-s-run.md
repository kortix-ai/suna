---
recorded: 2026-08-26T23:32:08Z
incident_date: 2026-08-27
commit: 09d70aac8d
---
# A web API the middleware needs must exist in the IMAGE's runtime, not the laptop's

**When:** adding any global middleware or hot-path code that uses a Web/Bun
API (`CompressionStream`, `DecompressionStream`, `ReadableStream.from`,
`Response.json`, …), or bumping/pinning Bun anywhere. `apps/api/Dockerfile`
pins `ARG BUN_VERSION=1.2` (1.2.23 today) while every developer laptop and
every CI lane runs Bun 1.3.x. `CompressionStream` does not exist in Bun 1.2.
The compress middleware from #6946 peeked the body of every eligible response
and then threw `ReferenceError: CompressionStream is not defined`, so on dev
**every API response ≥ 1 KiB answered 500** (`GET /accounts`, `account-state`,
`iam/permissions`, `iam/roles` — the whole account hub) while sub-KiB routes
and `/health` stayed green. 8,545 green unit tests, a green typecheck and a green
deploy proved nothing, because none of them ran on the image's Bun. Cloudflare
sends `Accept-Encoding: gzip` to the origin regardless of the client, so no
request could dodge the path.
**Rules:** (1) feature-detect any Web API a middleware uses at module load and
fail OPEN (skip the feature, never touch the body) when it is absent; (2) treat
`BUN_VERSION` in the Dockerfile as the runtime contract — either pin the
laptop/CI to it or add a test that runs the middleware under
`oven/bun:<BUN_VERSION>`; (3) a green `/health` after deploy is not a smoke
test — hit one route whose response exceeds 1 KiB.
*Incident:* dev broken 2026-08-26 22:41 → 2026-08-27 (fix in progress) — first
noticed only because the branding rollout verification hit `GET /accounts`.
*Enforcer:* `compress.test.ts` pins the fail-open path with `CompressionStream`
deleted from `globalThis`; nothing yet runs the suite under the image's Bun.
