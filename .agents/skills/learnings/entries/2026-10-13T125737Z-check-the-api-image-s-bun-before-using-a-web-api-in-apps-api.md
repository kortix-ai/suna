---
recorded: 2026-10-13T12:57:37Z
incident_date: 2026-10-13
---
# Check the API image's Bun before using a Web API in apps/api; hono/compress needs CompressionStream, which Bun 1.2 lacks

**Rule:** The API image runs the Bun of `ARG BUN_VERSION` in `apps/api/Dockerfile` (1.2, which resolves to 1.2.23). Tests run Bun 1.4.3. A Web API that Bun 1.2 lacks passes every local test and answers 500 on dev. Before you use a runtime API in `apps/api/src`, check it on the image's Bun. Do not add a route-level `hono/compress`: the global `compressResponse` (`apps/api/src/middleware/compress.ts`) already gzips every JSON response of 1 KiB or more and falls back to `node:zlib`. For a one-off buffer, use `Bun.gzipSync` or `node:zlib`.

**Trigger surface:** importing a Hono middleware or calling a Web API (`CompressionStream`, `DecompressionStream`, a new `Response`/stream static) in `apps/api/src`; reviewing a route that sets its own `Content-Encoding`.

**Incident:** 2026-10-13, Session Log Plan P6.1 (#9714). The restore route `POST /v1/projects/:projectId/sessions/:sessionId/log/restore` mounted `compress({ encoding: 'gzip' })`. On dev every request answered 500 (`ReferenceError: CompressionStream is not defined`), a user-token request that must get 403 included. The handler ran first, so each sandbox-credential call committed its claim (`session_logs.generation` + 1) and the caller never received the log. The DB suite and the SLOG-3 flow passed on Bun 1.4.3. No daemon calls the route yet, so no user was affected. This is the second time: the 2026-08-26 entry recorded the same `CompressionStream` gap in the global middleware; its tests pin that middleware only, so a new use elsewhere had no guard.

**Enforcement:** `tests/unit/api-image-bun-web-apis.test.ts` reads `BUN_VERSION` from `apps/api/Dockerfile`. While it is below 1.3, the test fails when a non-test file in `apps/api/src` other than `middleware/compress.ts` names `hono/compress`, `CompressionStream` or `DecompressionStream`. Not covered: other Web APIs Bun 1.2 lacks, and code in `packages/*` that the API imports. The complete fix is to move the image to the test Bun, a runtime change for every route.
