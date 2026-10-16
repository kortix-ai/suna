---
recorded: 2026-10-16T00:18:19Z
incident_date: 2026-10-15
---
# Prove a harness config change in a real session on both harnesses: unit tests pass while the tool silently vanishes

**Rule:** Before merging a change to what a harness receives (compiled agents, permissions, skills paths, plugins, commands), boot a real session on OpenCode AND pi on your local stack and assert the effect on the box: the tool list (`/experimental/tool/ids`), the agent list (`/kortix/runtime/state`), the skill list (`/skill`), and one real model turn that uses the thing. A green compiler test proves the JSON, not what the harness does with it. Write OpenCode permission maps with `*` first: OpenCode applies the LAST matching rule; pi applies the longest pattern.

**Trigger surface:** editing `apps/api/src/projects/lib/compile-agent-config.ts`, `harness/open-code/lifecycle.ts` / `manifest-v3.ts` / `extension-deps.ts`, `harness/pi/*`, the starter template's plugins, or the baked OpenCode deps in `apps/sandbox/Dockerfile` + `packages/shared/src/sandbox/dockerfile-layer.ts`.

**Incident:** 2026-10-15, kortix.yaml v3 (#10000). Every unit suite was green; real sessions found 5 defects before merge, each silent at runtime: (1) `{ worker: allow, '*': deny }` made OpenCode deny every subagent and skill of an allowlist and drop the `task` tool (also hit v2 skill allowlists); (2) a v3 release injected the Kortix skills where `skills.paths` never pointed; (3) a staged plugin copy kept the sealed release's read-only modes (`EACCES`); (4) `pty_spawn` failed on every starter project, v2 included, because nothing declared or baked the native `bun-pty`; (5) pi listed disabled agents. A sixth (#10002) showed only on dev: a session on a branch can carry an agent name its ref does not compile.

**Enforcement:** regression tests for each defect: `compile-agent-config.test.ts` (allowlist rules start with `*`), `opencode-config-composition.test.ts` (Kortix skills declared from the release), `opencode-extension-deps.test.ts` (sealed release folder), `opencode-command-gate.test.ts` (unknown session agent), `pi-harness.test.ts` (disabled agent not listed), `config-deps-version.test.ts` (bun-pty + zod pinned). The real-session check itself: none yet; the enforcer to build is a `pnpm test -- --browser-only`-style lane that boots one OpenCode and one pi session against a synthetic v3 project and asserts the tool, agent, skill and command lists.
