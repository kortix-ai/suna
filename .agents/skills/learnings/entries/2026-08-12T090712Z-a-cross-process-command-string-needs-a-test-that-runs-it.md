---
recorded: 2026-08-12T09:07:12Z
incident_date: 2026-08-12
commit: 92bd639e76
---
# A cross-process command string needs a test that RUNS it

**When:** one component spawns another by a hardcoded argv — the daemon's
OpenCode MCP entry (`apps/kortix-sandbox-agent-server/src/opencode.ts`), an
entrypoint script, a CronJob command. Asserting the literal proves only that
the string is what you just typed. Spawn it and require a real response.
Pinning both sides to the same literal is worse than no test: it makes the
typo look deliberate and survives review. Where the two packages cannot share
a constant (the daemon is standalone by design — hono + zod, no workspace
deps), read the argv from the producer and execute it in the consumer's test
(`apps/cli/src/__tests__/connectors-mcp-handshake.test.ts`).
*Incident:* e868be1d6c renamed the CLI command `executor` → `connectors` but
pointed the daemon at `connector`, singular. Every sandbox got `unknown
command` + exit 2, so the `kortix-connectors` MCP server never started for six
days. Both daemon unit tests were updated to assert the typo and stayed green;
the e2e tests that really spawn the server used the plural and also stayed
green, testing a path production never took. Blast radius was zero only because
`KORTIX_CONNECTORS_MCP_ENABLED` is off everywhere — the flag, not the tests, is
what contained it.
