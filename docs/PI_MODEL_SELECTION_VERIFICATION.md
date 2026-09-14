# Pi model selection verification

Branch: `pi-worker`. Draft PR: [#6998](https://github.com/kortix-ai/suna/pull/6998).
Preview: [pi.kortix.com](https://pi.kortix.com). No production merge.

## Contract

The worker snapshots the saved model when it accepts a new prompt.
Running, queued, and question/permission-paused prompts retain that snapshot.
A later model save does not change an already accepted prompt.
The agent, source commit, custom tools/hooks, resources, state, permissions, and
environment remain unchanged. Stop/resume preserves the selection and history.

## Real preview checks

Model behavior revision: `6bfb41b6dcfa38f1b867e9cc0f5dd1243727a528`.
Deployment: [34841293285](https://github.com/kortix-ai/suna/actions/runs/34841293285).
API health, checkout, and API/gateway/frontend image tags match this revision.
The custom-tool and provider-recovery checks below ran at `c0a4e666c4`.
The final revision adds selected-model refresh to the canonical reload snapshot.
Both model pickers are verified again at the final revision.

- The custom resource agent switches Luna → DeepSeek without rerunning initialization.
  Agent name, source SHA, worker identity, resource bytes, and denied undeclared
  access remain unchanged. No environment exists.
- A session created before model selection rejects a live change with `409`.
  Stop/resume upgrades it. The same live change then succeeds.
- The switched response emits 115 text deltas. After restart, DeepSeek emits 125.
  Nine historical message envelopes survive byte-for-byte before the next prompt.
- The real CLI saves Luna, exits `0`, reports “for new prompts”, and leaves the
  session running. The session row contains `kortix/gpt-5.6-luna`.
- The main browser switches Luna ↔ DeepSeek and keeps the agent locked.
  Each actual PUT contains the selected model and returns `200` with
  `applies_to: next_prompt`. The row stays running. Reload retains the selection.
  Luna shows image attachments; DeepSeek hides them, including after reload.
- The local production white-label UI uses the final preview API through its
  wrapper. Its model picker sends `{model: kortix/gpt-5.6-luna}`, receives `200`
  with `appliesTo: next_prompt`, shows the confirmation, and survives reload.
  Its temporary user store is isolated. The server and owned test workers are stopped.
- A native provider context rejection recovers and answers `2 — ORCHID-47`.
  Two total tool calls include the baseline call. The active call is not repeated.
  Eight message envelopes survive restart. The response emits 14 text deltas.

The large image check runs at preceding revision `1877cccc43`, whose attachment
implementation is unchanged by the worker recovery fix:

- A 1,600 × 1,600 PNG contains 7,682,253 bytes.
- Upload/read-back SHA-256 is
  `2936600696ac40f0de4a4fdeb7d24ecf37febabdd3319021b8d8963218cc071f`.
- Luna identifies the purple triangle on the left and yellow circle on the right.
- Exact bytes and two message envelopes survive stop/resume. No environment starts.
- Switching that conversation to text-only DeepSeek preserves its image history.
  DeepSeek answers from the previous text description.

## Automated coverage

Worker HTTP and recovery tests cover active and queued selections, duplicate
message IDs, model endpoint failure before admission, commands, reasoning/image
capabilities, custom initialization/state, manual compaction, and worker replacement
at question/permission boundaries. The worker suite passes 866 tests.

SDK tests cover selection persistence, immutable accepted turns, and navigation
while saving. The SDK suite passes 2,947 tests. Typecheck and installed-package
verification pass. White-label production HTTP checks pass both model route cases.
The CLI parity suite passes 56 real-process tests.

The complete package lane passes: `pnpm test -- --packages-only` (365.2 seconds).
It includes 9,420 API tests and 9,636 web tests; 82 existing API skips remain.
The final worker change also passes all 866 worker tests and its typecheck.

The final preview REST/CLI lane passes 465 of 468 flows, with zero failures.
Three existing skips remain: `CHN-6` has no connected Slack workspace;
`CONN-26` and `SESS-23` are quarantined upstream. SEC-J now passes.
The initial full command finds Chromium in the wrong cache directory and fails
its browser lane before navigation. The complete browser lane then starts with the installed cache path, but Docker
kills the frontend at its 2 GiB limit during the locale census. A healthy response
after its automatic restart does not count as a passing run.

The preview overlay now reserves 4 GiB and retains the 1.5 GiB Node heap ceiling.
Run the full target suite with
`PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright` in provider exec.
The PR records the final deployed SHA, full rerun results, and restart counters.

These results do not certify all OpenCode parity or mobile model controls.
See [the parity audit](./PI_OPENCODE_PARITY.md) for remaining capabilities.

## Manual test

1. Open a YAML v3 Pi session with a custom agent on the preview.
2. Ask its custom tool for a result. Note the selected agent and model.
3. Select another model available to your account. The save applies to new prompts.
4. Ask the same custom tool again. It keeps the same configuration and state.
5. Reload, then stop/resume. The selected model and conversation remain.
6. While a prompt runs or waits for a question, change the model and enqueue a
   second prompt. The accepted first prompt keeps its model. The second uses
   the new model if accepted after the save.
7. Select a text-only model. New image attachments are unavailable; existing
   images stay in the conversation.

Live agent switching, rewind, fork/subagents, and the remaining parity items stay
separate. No Durable Objects are required or enabled.
