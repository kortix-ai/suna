Realtime voice calls, a rewritten session transcript, and warm sessions

## New

- **Realtime voice calls.** Kortix joins a live call over LiveKit, answers out loud, and keeps the whole call in view — live transcript and the worker's tool calls now render in the session UI. The agent gets the entire call, not just the ability to start one, and it remembers where it got to so re-reading a transcript stops repeating itself.
- **A rewritten session transcript.** Narrative is the default reading, with one detail toggle: narrative at rest, full history on demand. Every expanded step is actionable rather than just readable, and thinking is interleaved with steps.
- **Warm sessions.** Projects keep one warm session ready, so starting work doesn't wait on a cold sandbox.
- **System skills.** `kortix system-skills` teaches an agent Kortix in one command, and the API serves the Kortix-managed skills from `/v1/skills`.
- **Templates bind to agents**, so a sandbox starts from the template its agent expects.
- **The white-label ACP reference is now SDK-only.**

## Changed

- **The Recall.ai notetaker is gone**, replaced by the direct LiveKit bridge. `meet` is renamed to `voice` across the CLI, API channels and SDK, and the deprecated `channels.meet` compatibility shim has been removed. If you referenced `meet`, use `voice`.
- **Voice runs on LiveKit Cloud with no vendor keys**, and is a normal experimental feature rather than sitting behind an operator environment gate.
- **The New Project dialog is simpler** — a name field plus an opt-in repository source.

## Improved

- Less sandbox control-plane chatter and lower ambient-poll latency; turn-stream lease polling has been replaced.
- The composer puts agent and model back inline, drops the toolbar-mode switch, and collapses the overflow into one list.
- The model provider connection flow reads more clearly.

## Fixed

- Sandbox secret injection is scoped to the agent that actually runs, instead of being handed to every agent in the session.
- In-sandbox agents can read `/v1/skills` again — this was returning 403.
- Billing reconciles per-seat sandboxes whose compute window was lost, and rotations no longer run on workerless pods.
- Maintenance mode fails over independently at the edge, so the notice survives an API outage.
- The computer connector now requires a machine that has actually connected, not just a tunnel row.
- Clicking a step opens that tool call rather than the last one, and expanded steps show the real command instead of "Ran a command".
- Voice hardening: join links carry a short server-resolved token instead of a raw LiveKit JWT, `ask_kortix` is bounded so a confused call can't spend forever, the call knows who is speaking, and rooms whose metadata points at a dead API are not reused.
- Transient Supabase pool exhaustion no longer floods Sentry.
- SDK: ACP and REST prompt completion is monotonic, REST prompts reconcile before the first event, and project agent selection is preserved.
