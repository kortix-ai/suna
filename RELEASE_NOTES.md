Realtime voice, session rewind, warm sessions, and Marketing Department

## New

- Realtime voice calls use LiveKit Cloud and preserve transcripts and worker tool calls in the session UI.
- Session rewind restores REST and ACP sessions from a selected message.
- Warm sessions keep one session available per project to reduce cold-start latency.
- The Marketing Department template adds campaign, content, lifecycle, growth, and brand agents.
- Connection policies canonicalize connector aliases and enforce the selected shared connection across grant gates.
- KaaB isolation restricts session access, sharing, approvals, model changes, executor grants, connector use, and OpenCode proxy access.
- KaaB spend controls enforce per-end-user limits.
- Secret Delivery Strategy stage 1 adds the schema, policy layer, and shared egress-policy type.
- White-label session scope controls add end-user session filtering, connector binding, scope visibility, and a testing guide.

## Improved

- Prompt delivery deduplication releases the claim after a final sandbox-down response. A later retry can recover without duplicating a completed prompt.
- Session transcripts preserve reasoning and tool-step wire order.
- Runtime-generated session titles synchronize with the canonical session and web UI.
- Managed repository provisioning uses deterministic pacing and 13 reusable repositories in the release gate.
- The release gate runs API lanes in parallel and cleans mutable staging fixtures concurrently.

## Fixed

- Session sharing preserves permission status during warm-session claim races.
- Sandbox secret injection remains scoped to the active agent.
- Strict model providers receive normalized message history.
- `readRepoFile` returns `404` for a missing Git path.
- Maintenance mode remains visible during an API outage.
- Worktree shutdown stops the complete process tree.

## Operations

- US East 2 shadow deployment, database reconciliation, writer activation, and cutover tooling remain disabled.
- This release does not freeze the EU database or switch production traffic.
