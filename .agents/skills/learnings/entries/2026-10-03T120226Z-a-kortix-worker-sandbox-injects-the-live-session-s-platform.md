---
recorded: 2026-10-03T12:02:26Z
incident_date: 2026-10-03
---
# A Kortix worker sandbox injects the live session's platform env into every spawned child, so a hermetic test suite must scrub it

**Rule:** A test that spawns a CLI, daemon, or compiled runtime must not inherit the ambient agent shell. Scrub the platform-injected names (KORTIX_SESSION_ID, KORTIX_SUPERVISED, KORTIX_API_URL, KORTIX_TOKEN, KORTIX_FRONTEND_URL, KORTIX_PROJECT_ID, the compiled-runtime identity: KORTIX_BASE_SHA, KORTIX_BASE_REF, KORTIX_DEFAULT_BRANCH, KORTIX_COMPILED_AGENT_CONFIG, KORTIX_COMPILED_AGENT_CONFIG_ETAG, KORTIX_COMPILED_RUNTIME_FORMAT, KORTIX_COMPILED_RUNTIME_SOURCE_SHA) in one place per package — an env file (`apps/api/scripts/test.env`) or a bunfig `[test] preload` (`apps/cli`, `apps/kortix-sandbox-agent-server`) — and set `KORTIX_DISABLE_SANDBOX_ENV_FILE=1` so children also skip the sandbox-env file. A spawn with a RESTRICTED env literal must carry the kill switch itself: it inherits nothing.

**Trigger surface:** Any workspace test suite that spawns child processes and is expected to pass both on a laptop and inside a Kortix worker sandbox (`pnpm test` green, the test-attestation gate).

**Incident:** 2026-10-03, the day the local test-attestation gate (#8850) made a green `pnpm test` the push condition. In every Kortix worker sandbox, 16 api tests (`e2e-connector-faces`, `compileOpenCodeRuntime`, `compilePiRuntime`), 32 CLI golden tests, and kortixd's lifecycle e2e failed, identically at `origin/main`, for one root cause: a spawned child with a minimal or inherited env falls back to the sandbox's own `/dev/shm/kortix/agent-env.sh` (KORTIX_TOKEN, KORTIX_API_URL, KORTIX_PROJECT_ID) and shell exports (`KORTIX_SESSION_ID`, `KORTIX_SUPERVISED`, `KORTIX_LLM_PROXY_URL`, `KORTIX_BASE_SHA`), then reaches the test's fake gateway with a foreign project id, renders " · session <id>" into golden output, or refuses a compiled identity it did not compile under (exit 78). Fixed for api and cli on KRTX-1286's branch; kortixd still carries failures whose fixtures read the sandbox's real `/opt/kortix/llm-catalog.json` and need their own redesign.

**Enforcement:** None yet: a validator check that greps each suite's entry point (env file / preload) for the scrub list, and fails a spawn-based test file that constructs a child env without it.
