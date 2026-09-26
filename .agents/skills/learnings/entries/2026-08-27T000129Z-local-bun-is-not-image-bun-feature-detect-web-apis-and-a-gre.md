---
recorded: 2026-08-27T00:01:29Z
commit: 3d5b5351e1
---
# Local Bun is not image Bun — feature-detect web APIs, and a green health gate proves only /health

- **Incident (2026-08-26):** compress middleware (round-7 perf PR) called `CompressionStream`. Local dev + CI run Bun 1.3.14 (has it); the API image is `oven/bun:1.2-slim` = Bun 1.2.23 (does not). Every response ≥1KB on a compressible type 500'd (`ReferenceError`) on dev-api and SampleCo; `/health` is <1KB, skipped the path, stayed 200 — so the deploy verification gate passed while `GET /v1/projects/:id` 500'd and the project shell showed "This project didn't load".
- **Rule:** any Web/runtime global used in `apps/api` (or anything shipped in the Bun image) must exist in the image's Bun line (`ARG BUN_VERSION` in `apps/api/Dockerfile`), not just locally. Feature-detect (`typeof X !== 'undefined'`) with a `node:*` fallback, or bump and test the image's Bun. Deployed-SHA health checks do not exercise real routes — after a deploy that touches the response path, hit one real authenticated >1KB route.
- **Enforcement:** `compressedStream()` in `apps/api/src/middleware/compress.ts` feature-detects and falls back to `node:zlib`; `compress.test.ts` pins the forced-fallback path (`useNative:false`) so the image path is exercised by CI forever.
