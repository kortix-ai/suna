---
recorded: 2026-10-15T19:13:35Z
incident_date: 2026-10-14
---
# Never put an unbounded value in one sandbox env var; Linux refuses an exec whose NAME=VALUE string passes 128 KiB

**Rule:** A value that grows with the project (compiled agent config, catalogs, prompts) never travels as one env var. Send it through `encodeCompiledAgentConfigEnv` (gzip+base64 parts, each under 128 KiB) or as a file. kortixd writes such a value into `process.env` only through `setCompiledAgentConfigEnv`, because every child exec inherits it. A new oversized form goes only to a daemon that declares the capability for it (`agent-config.env-gz.v1`), on every delivery path: create env, `/kortix/env` push, and the config-release descriptor.

**Trigger surface:** Adding or growing a sandbox env var in `buildSessionRuntimeEnv` / `buildSessionSandboxEnvVars`; anything kortixd assigns to `process.env` from an API response.

**Incident:** 2026-10-14, Platinum prod: 25 of 25 session creates whose `KORTIX_COMPILED_AGENT_CONFIG=…\0` was 131,734–269,979 bytes never booted (about 4 min of retries each); 1,587 of 1,587 under the limit booted. An enterprise workspace with 15 declared subagents (~270 KB of prompts) could not declare them. Fixed by PR #9898's codec plus the config-release gate (`governanceForDaemon`), merged in the PR that closed #9898.

**Enforcement:** `packages/api-contract/src/__tests__/compiled-agent-config-env.test.ts` (size boundary, round trip, prod sizes); `apps/api/src/projects/lib/compile-agent-config.test.ts` "a compiled config over 128 KiB" (17 agents, every env string within the limit); `apps/api/src/config-releases/__tests__/governance-for-daemon.test.ts`. Platinum refuses a create with one env string over the limit (`400 env_var_too_large`). None yet for a NEW unbounded env var: a test over `buildSessionSandboxEnvVars` that fails on any value without a size bound.
