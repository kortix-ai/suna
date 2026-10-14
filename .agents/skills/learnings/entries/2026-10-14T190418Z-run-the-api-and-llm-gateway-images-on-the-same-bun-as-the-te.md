---
recorded: 2026-10-14T19:04:18Z
incident_date: 2026-10-13
supersedes: 2026-10-14T133039Z-run-the-api-image-on-the-same-bun-as-the-test-lanes.md
---
# Run the API and LLM gateway images on the same Bun as the test lanes

**Rule:** `ARG BUN_VERSION` in `apps/api/Dockerfile` and in `apps/llm-gateway/Dockerfile` is the exact `bun-version` of `.github/workflows/tests.yml` (1.4.3). Bump the three pins in one PR, and build and boot each changed image before it merges. Code that runs in another Bun is a different case: the sandbox daemon is compiled on `SANDBOX_AGENT_BUN_VERSION` (1.3.11), so a file the API builds for the daemon (pi pre-built extensions) must parse on that Bun.

This rule also replaces the "feature-detect with a `node:*` fallback" clause of `2026-08-27T000129Z-local-bun-is-not-image-bun-feature-detect-web-apis-and-a-gre.md`: that fallback (`compressedStream()`) is deleted. Its other clause still holds: after a deploy that touches the response path, hit one real authenticated route over 1 KiB.

**Trigger surface:** changing any Bun pin; adding a Bun service image; using a Web API or new syntax in `apps/api/src`, `apps/llm-gateway/src` or `packages/llm-gateway/src`; reviewing a "works locally, 500 on dev" bug.

**Incident:** the API image ran Bun 1.2.23 while tests ran 1.3/1.4. `CompressionStream` 500'd dev twice (2026-08-26 global compress middleware; 2026-10-13 the session-log restore route, PR #9720). PR #9848 moved the API image to 1.4.3. The LLM gateway image kept `BUN_VERSION=1.2` with the same gap on every model call; branch `gateway-bun-143` moved it to 1.4.3.

**Enforcement:** `tests/unit/image-bun.test.ts` fails when either Dockerfile pin is not an exact `x.y.z` or differs from the test-lane pin. Not covered: the daemon's Bun. A pi extension that uses `using` pre-builds on 1.4.3 into a file Bun 1.3.11 cannot parse; the daemon then loads it from the `node_modules` fallback (measured with a synthetic package).
