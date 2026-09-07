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

The selected compiled agent's `temperature` and `top_p` apply to every provider
request. Explicit zero values are preserved. Omitted fields retain provider
defaults. OpenAI-compatible requests use Pi sampling options. Native Anthropic
requests retain Pi's temperature handling and add `top_p` to the provider payload.

The selected agent's `steps` limits model iterations per prompt. The final
iteration requests a text summary with completed work, unfinished tasks, and
the next action. `steps: 1` requests that summary immediately. Tools are absent
from the final provider request. A provider that still requests a tool receives
a blocked tool result, and the loop stops without executing it. A new prompt
resets the budget. Omitted `steps` retains the unrestricted loop. The limit
does not alter the saved system prompt or tool discovery.

The configured gateway URL overrides the endpoint for catalog models and new
model references alike. Catalog membership must never bypass the gateway or
send the session credential to a provider's public endpoint.

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

Durable workers advertise `x-kortix-prompt-admission: durable-message-id-v1`.
The API reads this capability from the current transcript response. It preserves
`messageID` and forwards retries to the durable journal. Older runtimes keep
proxy duplicate protection. An explicit `Idempotency-Key` continues to use the
proxy contract. The capability check adds no read to a normal browser prompt.

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
Provider cancellation remains `MessageAbortedError` in the live and restored transcript.
An unreachable cancellation endpoint returns an error instead of claiming that
the remote operation stopped. Runtime layer v47 supplies that endpoint.

An authentication rejection before execution allows one credential refresh and
retry. A disconnected mutation is never replayed because its side effect can
already have committed. Read operations can retry after reconnecting.

Prompt routes accept text parts, `messageID`, `system`, `noReply`, and the compiled
agent and model. A prompt's `system` string appends to the compiled instructions
for that prompt. It survives queued delivery and accepted-only replay. A retry
must preserve it; changing it under the same `messageID` returns `409`. The
worker restores the compiled instructions after completion or failure. An empty
string adds no instructions and remains an explicit field in the saved message.

`noReply: true` stores a user message without calling the model or starting the
environment. The synchronous route returns that user message with `200`; the
asynchronous route returns `204` after durable admission. Context follows the
normal queue order and enters the next model prompt. Replacement workers finish
partially stored context without adding an interruption. Exact retries return
the same message. `false` and an omitted `noReply` both request a model response.
Changing between context-only and model execution under one `messageID` returns
`409`. A context-only input does not apply its `system` to later prompts.

Unsupported fields return `400` before admission. The body and each
durable log item are limited to 512 KiB. Attachments and the remaining OpenCode
prompt options are still compatibility gaps.

Compiled commands and command requests may explicitly select the current agent
and model. A different selection still requires another compiled runtime.
An empty command file list is accepted. Nonempty file lists, child sessions,
variant overrides, file references, and shell interpolation remain unsupported.

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
