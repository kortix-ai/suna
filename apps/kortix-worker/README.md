# @kortix/worker

The pi-based session worker: the harness, and only the harness. Part of the
harness/worker split (`docs/specs/2026-08-26-harness-worker-split.md`).

## What this package is

A single HTTP+SSE server wrapping `@earendil-works/pi-agent-core`'s `Agent`.
All six default tools (`bash`, `read`, `write`, `edit`, `glob`, and `grep`)
resolve their filesystem and shell through an injected `ExecutionEnv` that
RPCs into a separate environment. Pi 0.84.3 supplies the first four tools.
Kortix supplies `glob` and `grep` adapters because that release exports no
search-tool factories. No default tool can touch the worker's own disk
(`src/workspace-tools.ts`, `src/kortix-env.ts`).

It is **not deployed on its own**. `bun run build` produces one self-contained
`dist/worker-runtime.mjs` (nothing resolved at runtime); the API's
compiled-boot pipeline prepends per-`(project, sha)` agent config compiled from
`kortix.yaml` and serves the result:

```
push → apps/api/src/git-proxy/index.ts (pi_worker flag on)
     → compiled-pi-runtime-artifact.ts (cache, single-flight)
     → GET /v1/git/{project}.git/compiled-pi-runtime?ref&sha
```

The artifact self-describes: line 2 is a `// kortix-manifest-base64url:` marker,
`node artifact.mjs --manifest` prints it, and baked identity env vars fail
closed (exit 78) on mismatch.

## Config precedence

`main.ts` reads `globalThis.__KORTIX_COMPILED__` (the bake) and overlays env:
env vars win, because the control plane knows session-start facts (model
override, session id, environment URL) that a per-commit artifact cannot.

## Permission approvals

The `question` tool and permission prompts use the existing OpenCode UI
contracts. `once` permits one tool invocation. `always` saves the approved
permission and patterns in the session's durable log before the tool resumes.
Those grants survive a worker restart or replacement within the same session.

If the approval cannot be saved, the reply route returns `503`. The request
stays pending and the tool does not run. Retrying the reply uses the same
idempotency key. Stop still cancels the blocked tool during a pending save.
Rejected and one-time replies do not create durable grants.

Pending question and permission continuations still require a live worker.
Durable approval grants do not make those blocked continuations restartable.

## Turn admission and recovery

The worker saves each accepted prompt before returning `204`. A serial queue
starts prompts in durable acceptance order. Retrying the same `messageID` and
input reuses the first admission. Reusing that ID with different input returns
`409`. Cancelling a queued message commits before removing it from the UI.

A turn-owner lease fences transcript writes and completion. A replacement
worker resumes accepted prompts that never started. It does not replay a turn
that could have executed a tool. It restores the committed answer or records
one interruption, preserving message IDs and parent links.

The session stays busy until durable reconciliation finishes. Recovery removes
stale streamed messages before publishing idle. A durable completion also keeps
its control-plane notification pending until delivery succeeds.

Stop records an abort request and waits for the owner to acknowledge it. File
and shell operations receive cancellation through the environment transport.
The daemon kills the shell process group before acknowledging cancellation.
An unreachable cancellation endpoint returns an error instead of claiming that
the remote operation stopped. Runtime layer v47 supplies that endpoint.

An authentication rejection before execution allows one credential refresh and
retry. A disconnected mutation is never replayed because its side effect can
already have committed. Read operations can retry after reconnecting.

Prompt routes currently accept text parts, `messageID`, and the compiled agent
and model. Unsupported fields return `400` before admission. The body and each
durable log item are limited to 512 KiB. Attachments and the remaining OpenCode
prompt options are still compatibility gaps.

The direct Pi versus OpenCode benchmark and its raw measurements are documented
in [`DIRECT_ENVIRONMENT.md`](../../spikes/pi-worker/bench/DIRECT_ENVIRONMENT.md).

## Standalone runtime build

The package participates in the pnpm workspace and keeps its own `bun.lock`
for the standalone runtime build. Keep both lockfiles synchronized when changing
dependencies. Pin Pi 0.84.3 exactly. This worker uses the verified `Agent` surface;
it does not use the unimplemented `AgentHarness` surface in that release.

## Tests

Run `bun run test`, `bun run typecheck`, and `bun run build` inside this package.
The repository root `pnpm test -- --packages-only` command runs the standalone
gates. It also runs `pi-worker-bundle.test.ts` and
`pi-worker-lockdown.test.ts` against the real `dist/worker-runtime.mjs`. The
required-bundle mode fails when the build artifact is absent; it never records
that proof as skipped.

Provenance: graduated from `spikes/pi-worker` (PR #6924), where the Phase 0
gates S0.1–S0.5 and the Daytona benchmarks live.
