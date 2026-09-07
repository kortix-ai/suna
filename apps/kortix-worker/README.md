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

## Upgrading workers without saved wire IDs

An early Pi worker saved native messages but kept its OpenCode message IDs only
in memory. Those random live IDs cannot be reconstructed from the native log.
Capture them before that old process stops.

`captureLegacyWireIdentities(sessionId, branchEntries, liveMessages)` validates
ordered messages, text, reasoning, settled tools, and part ownership. It returns
one atomic journal checkpoint. Each identity is bound to the native entry by a
canonical SHA-256 fingerprint. The checkpoint contains IDs and timestamps;
it does not duplicate or rewrite message content.

For an upgrade, save the complete native log and live transcript while the
session has no active or queued turns, questions, or permission requests.
Preflight the checkpoint against the 512 KiB log-item limit. Stop the worker,
confirm the native log still matches the capture, then append the checkpoint
with a stable idempotency key before starting the new worker. Do not append a
checkpoint if the capture changed. Keep the saved capture until the restored
message IDs, part IDs, timestamps, and content match it.

Replay rejects stale fingerprints, foreign sessions, reused IDs, and conflicting
checkpoints. Existing entries remain unchanged. Subsequent messages use the
normal durable admission path. Workers that already persist wire IDs do not
need this checkpoint.

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
send the session credential to a provider's public endpoint. Short compiled
model references such as `gpt-5.6-luna` retain their model identity; they must
not fall back to the first provider catalog entry. Explicit session model
overrides still take precedence.

## Web search

The `websearch` tool uses Exa's public MCP endpoint, matching OpenCode's Exa
query options: `query`, `numResults`, `type`, `livecrawl`, and
`contextMaxCharacters`. Defaults are eight results, automatic search, fallback
live crawling, and 10,000 context characters. It returns source text that the
existing web search cards render. The worker sends no session credential to Exa.

Search uses the `websearch` permission with the query as its resource. Stop
cancels the provider request. A 25-second deadline and 256 KiB response limit
bound each call. HTTP, RPC, and tool failures stay tool errors. Search does not
start the execution environment. Parallel-provider routing and private Exa key
configuration are not implemented.

## Permission approvals

The `question` tool and permission prompts use the existing OpenCode UI
contracts. `once` permits one tool invocation. `always` saves the approved
permission and patterns in the session's durable log before the tool resumes.
Those grants survive a worker restart or replacement within the same session.

If the approval cannot be saved, the reply route returns `503`. The request
stays pending and the tool does not run. Retrying the reply uses the same
idempotency key. Stop still cancels the blocked tool during a pending save.
Rejected and one-time replies do not create durable grants.

Permission wildcards match multiline commands and normalize path separators.
A rule ending in ` *` matches its bare command as well as its arguments. Rule
ordering remains significant: the last matching rule wins. These semantics
match [OpenCode's wildcard implementation](https://github.com/anomalyco/opencode/blob/v1.18.23/packages/opencode/src/util/wildcard.ts).

Pending permission continuations also survive worker replacement. Before showing
a request, the worker saves its native tool batch, request ID, and authorization
stage. Primary, external-directory, and repeated-tool approvals remain distinct.
An earlier one-time approval remains scoped to its original tool invocation.
It does not become a session grant.

All permission responses commit before HTTP acknowledgment. Recovery consumes a
saved response without asking again. A saved grant cannot bypass an unanswered
checkpoint from an interrupted approval. The worker commits one release fence
for the tool's authorization stages before executing it. Death after that fence
interrupts the turn instead of repeating an uncertain side effect.

Restoration reuses the shared tool-batch replay path for questions and permissions.
Completed tool results retain their wire identities and never repeat their effects.
Restored tool history preserves the repeated-tool guard. Stop cancels a restored
permission, and another worker's queued prompt waits for its resolution.

The web composer respects each question's `custom` flag. Choice-only questions
use the option buttons; multiple selections advance with Next. Custom answers
remain available when allowed. Confirm submits the collected answers without
appending a free-form note. Normal text entry returns after the question settles.

The web question card remains visible while a reply or dismissal is pending.
A failed request leaves the card answerable and shows an error. Custom text
survives a failed submission. A failed dismissal does not abort the turn.
Only an accepted response removes the question from local pending state.

## Questions across worker replacement

A durable question commits its native transcript and a question checkpoint
before publishing the card. The checkpoint preserves the request ID, question
content, tool call, and owning turn. A reply commits the answer before returning
`200`. Failed answer storage returns `503` and keeps the question pending.

After an abrupt worker replacement, the new owner claims the turn lease and
restores the same question. It reuses completed results from that tool batch;
it does not repeat their file writes, shell commands, or model request. The
remaining tool calls run after the answer. The agent retains its step budget,
system instructions, and tool controls. Stop cancels a restored question.

The answer remains recoverable until a durable release fence commits. That
fence precedes the next tool or model boundary. A crash after release uses the
ordinary interrupted-turn recovery; it never repeats an uncertain side effect.
A crash before an answer's HTTP acknowledgment restores the committed answer
without asking the user again. Invalid or conflicting checkpoints fail closed.

A native tool-call ID is scoped to its assistant message. A later provider
response can reuse that ID; its question receives a new request and answer.
Recovery preserves both questions instead of reusing the earlier response.

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

A completed durable prompt response includes `x-kortix-prompt-message-id` and
`x-kortix-prompt-completed` (`idle` or `error`). This also applies to completed
async retries. The API binds the receipt to the request's identity, accepts its
delivery record, and closes only that exact message. A retry cannot leave a new
active turn behind or close an unrelated prompt without a message ID. Retrying
a cancelled message returns `409` on both prompt routes.

A turn-owner lease fences transcript writes and completion. A replacement
worker resumes accepted prompts that never started and checkpointed interactions.
It does not replay an uncertain model or tool boundary. Otherwise, it restores
the committed answer or records one interruption, preserving message IDs and
parent links.

Transient session-log read failures preserve a running turn until its last
confirmed owner lease expires. A monotonic timer cancels model and tool work
at that deadline, including when a network request remains blocked. An explicit
ownership conflict cancels immediately. When storage returns, the same worker
retries durable reconciliation without requiring another user prompt. Recovery
uses the existing checkpoint and interruption rules. It never retries an
uncertain transcript append in the same process.

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

Prompt routes accept text parts, `messageID`, `system`, `noReply`, `tools`, and the compiled
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

`tools` maps permission names to booleans. A nonempty map replaces the session's
previous prompt controls when that queued prompt starts. Omitted controls and
an empty map retain the previous rules. These rules persist through context-only
prompts, provider failures, and worker replacement. Cancelled queued prompts do
not change them. A completed retry does not reapply old controls.

Tool visibility and authorization follow the compiled permissions plus session
controls. A wildcard deny removes tools from the model registry; the provider
cannot execute a removed tool. Rule order matters and is part of retry identity.
As in OpenCode, `edit` controls both `edit` and `write`. `write: false` alone does
not disable the `edit` permission. The user message retains its `tools` map, and
the session read exposes the active permission rules.

`PATCH /session/:id` accepts a `permission` ruleset. The update commits before
HTTP 200 and publishes `session.updated`. Session reads refresh the durable
rules, including changes made through another worker. A blanket allow survives
worker replacement and a closed browser tab. Existing pending requests still
require a reply. Each later authorization reads the current rules before it runs.

An explicit ruleset replaces earlier session controls and clears prior always
grants. `permission: []` restores compiled policy. A later nonempty prompt `tools`
map replaces those session rules when its turn starts. Empty and omitted maps
retain them. Grant records carry the permission update identity, so an older
approval write cannot reinstate a grant after a concurrent reset. Unsupported
session fields return 422; invalid rules return 400. Failed storage returns 503
without claiming the update succeeded.

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
