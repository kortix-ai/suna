Realtime voice calls, session rewind, warm sessions, and Marketing Department

## New

- **Realtime voice calls.** Kortix joins a live call over LiveKit, answers out loud, and keeps the transcript and worker tool calls in the session UI.
- **Session rewind.** REST and ACP sessions can rewind from a selected message while preserving canonical session state.
- **Warm sessions.** Projects keep one warm session ready to reduce cold-start latency.
- **Marketing Department project template.** The marketplace now includes a multi-agent marketing operating system with campaign, content, lifecycle, growth, and brand roles.
- **System skills.** `kortix system-skills` installs Kortix-managed skills, and the API serves them from `/v1/skills`.
- **Templates bind to agents.** A sandbox starts from the template assigned to its agent.
- **The white-label ACP reference is SDK-only.**

## Changed

- **Voice uses LiveKit Cloud.** The Recall.ai notetaker and the deprecated `meet` compatibility surface are removed.
- **The New Project dialog is simpler.** It uses a name field and an optional repository source.
- **Connector aliases are canonical.** Grant checks use one alias across all connector boundaries.

## Improved

- Session transcripts interleave reasoning and tool steps in wire order.
- Expanded steps show the exact command or file path.
- Clicking a transcript step opens the selected tool call.
- Sandbox control-plane polling performs fewer ambient requests.
- The model selector handles unavailable defaults without blocking selection.
- Strict model providers receive normalized message history.
- White-label sessions can select the shared connection used for execution.

## Fixed

- Sandbox secret injection is scoped to the agent that runs.
- In-sandbox agents can read `/v1/skills` without a `403` response.
- Billing reconciles per-seat sandboxes whose compute window was lost.
- Maintenance mode remains visible during an API outage.
- Voice join links use short server-resolved tokens instead of raw LiveKit JWTs.
- Transient Supabase pool exhaustion no longer floods Sentry.
- ACP and REST prompt completion remains monotonic.
- Production US cutover gates verify the exact API source commit and restrict writer activation to `prod`.
