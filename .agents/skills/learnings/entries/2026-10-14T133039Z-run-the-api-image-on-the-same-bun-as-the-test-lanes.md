---
recorded: 2026-10-14T13:30:39Z
incident_date: 2026-10-13
supersedes: 2026-10-13T125737Z-check-the-api-image-s-bun-before-using-a-web-api-in-apps-api.md
---
# Run the API image on the same Bun as the test lanes

**Rule:** `ARG BUN_VERSION` in `apps/api/Dockerfile` is the exact `bun-version` of `.github/workflows/tests.yml` (1.4.3). Bump both in one PR, and build and boot the image before it merges. Code that runs in another Bun is a different case: the sandbox daemon is compiled on `SANDBOX_AGENT_BUN_VERSION` (1.3.11), so a file the API builds for the daemon (pi pre-built extensions) must parse on that Bun.

This rule also replaces the "feature-detect with a `node:*` fallback" clause of `2026-08-27T000129Z-local-bun-is-not-image-bun-feature-detect-web-apis-and-a-gre.md`: that fallback (`compressedStream()`) is deleted. Its other clause still holds: after a deploy that touches the response path, hit one real authenticated route over 1 KiB.

**Trigger surface:** changing either Bun pin; using a Web API or new syntax in `apps/api/src`; reviewing a "works locally, 500 on dev" bug.

**Incident:** the image ran Bun 1.2.23 while tests ran 1.3/1.4. `CompressionStream` 500'd dev twice (2026-08-26 global compress middleware; 2026-10-13 the session-log restore route, PR #9720). Branch `api-image-bun-1-4` moved the image to 1.4.3, deleted the `node:zlib` fallback in `middleware/compress.ts` and its tests, and replaced the `CompressionStream` name guard.

**Enforcement:** `tests/unit/api-image-bun.test.ts` fails when the two pins differ. Not covered: the daemon's Bun. A pi extension that uses `using` pre-builds on 1.4.3 into a file Bun 1.3.11 cannot parse; the daemon then loads it from the `node_modules` fallback (measured with a synthetic package).
