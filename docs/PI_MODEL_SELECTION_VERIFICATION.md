# Pi model selection verification

Branch: `pi-worker`. Draft PR: [#6998](https://github.com/kortix-ai/suna/pull/6998).
Preview: [pi.kortix.com](https://pi.kortix.com). No production merge.

## Contract

A model change applies to prompts accepted after the save completes. Running,
queued, and question/permission-paused prompts retain their accepted model.
The agent, source commit, custom tools/hooks, resources, state, permissions, and
environment remain unchanged. Stop/resume preserves the selection and history.

## Real preview checks

Code revision: `c0a4e666c4f5c4f362befa219262b8179fc64657`.
Deployment: [34839124700](https://github.com/kortix-ai/suna/actions/runs/34839124700).
API health, checkout, and API/gateway/frontend image tags match this revision.

- The custom resource agent switches Luna → DeepSeek without rerunning initialization.
  Agent name, source SHA, worker identity, resource bytes, and denied undeclared
  access remain unchanged. No environment exists.
- A session created before model selection rejects a live change with `409`.
  Stop/resume upgrades it. The same live change then succeeds.
- The switched response emits 115 text deltas. After restart, DeepSeek emits 125.
  Nine historical message envelopes survive byte-for-byte before the next prompt.
- The real CLI saves Luna, exits `0`, reports “for new prompts”, and leaves the
  session running. The session row contains `kortix/gpt-5.6-luna`.
- The main browser model picker changes the selection and keeps the agent locked.
  DeepSeek removes the image attachment control. Reload retains the selection.
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
at question/permission boundaries. The worker suite passes 862 tests.

SDK tests cover selection persistence, immutable accepted turns, and navigation
while saving. The SDK suite passes 2,947 tests. Typecheck and installed-package
verification pass. White-label production HTTP checks pass both model route cases.
The CLI parity suite passes 56 real-process tests.

Full-suite failures are recorded in [the parity audit](./PI_OPENCODE_PARITY.md).
These focused results do not certify all OpenCode parity or every host UI.

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
