---
recorded: 2026-10-03T16:40:55Z
incident_date: 2026-10-03
---
# Unit suites that spawn or import Kortix CLIs and harnesses must sanitize the runner session env and disable the sandbox env file — CI's clean env hides every leak

**Rule:** A test that spawns a Kortix CLI or boots a harness must (1) delete the
session env keys it asserts against — `KORTIX_SUPERVISED`, `KORTIX_SESSION_ID`,
`KORTIX_API_URL`, `KORTIX_TOKEN`, `KORTIX_PROJECT_ID`, `KORTIX_MODEL`,
`KORTIX_OPENCODE_MODEL`, `KORTIX_HARNESS`, `KORTIX_REPO_URL`, the
`KORTIX_COMPILED_*` identity set — and (2) set
`KORTIX_DISABLE_SANDBOX_ENV_FILE=1` on every subprocess. Both channels carry
the developer box's real identity: `process.env` in the runner, and
`/dev/shm/kortix/agent-env.sh` (with the session's real token) for every CLI
that falls back to it. A suite that skips either is green in CI and red in the
one environment this repo is developed in.

**Trigger surface:** Writing or reviewing any test under `apps/cli`,
`apps/api` or `apps/kortix-sandbox-agent-server` that spawns a process or reads
`process.env` in `beforeEach`; also `package-quality.ts` workspace invocations.

**Incident:** 2026-10-03, after main's `Tests` daily run went red
(37101103578, lanes packages + core). Main's two named causes were fixed by
unrelated merges within hours, but every factory worker still could not
attest: 61 packages-lane tests read the runner's session env or the sandbox
agent-env file and failed only inside a Kortix sandbox, and the lane's failure
order masked them behind the first failing package for every earlier run. The
fix (one PR): env sanitization per failing file, `KORTIX_DISABLE_SANDBOX_ENV_FILE`
on every CLI spawn the API suite makes, the agent-server preload deleting the
session set, and two product hardenings the failures exposed (a compiled
runtime that indexes local chunk sources at the manifest's chunk size without
bound, and a mobile highlighter that caches a tokenizer's aborted-line output).

**Enforcement:** `tests/bin/package-quality.ts` `hermeticWorkspaceEnv()`:
the packages lane scrubs every `KORTIX_*` var but its own runner controls and
sets `KORTIX_DISABLE_SANDBOX_ENV_FILE=1`, `KORTIX_PT_ENV_PATH`,
`KORTIX_BAKED_LLM_CATALOG_PATH` and `KORTIX_MANAGED_SKILLS_DIR` at
nonexistent paths — one place, for every workspace suite. A suite that leaks
through a NEW channel (a second host-baked file, a new identity var) goes red
on the first factory worker's `pnpm test`; name the channel there, not in
per-file `beforeEach` blocks.
