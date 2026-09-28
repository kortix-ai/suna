---
recorded: 2026-09-25T23:43:08Z
incident_date: 2026-09-25
---
# Re-check a precondition at the moment it becomes irreversible, not once before the work

**Rule:** When a guard says "it is safe to destroy X" and the destruction happens
seconds later, ask again immediately before the destroying step. A single check
at the top of a multi-second operation is a TOCTOU, and the window is exactly as
long as the work in between. Pass the guard down as a callback to the function
that commits — do not re-derive it there, and do not shorten the work instead.
The same applies to a memo that a guard reads: a process-local cache invalidated
only in the process that saw the change is not an invalidation when more than one
process serves traffic. Broadcast the drop; a shorter TTL narrows the window and
never closes it.

**Trigger surface:** any "is a turn/job/request running?" check before a restart,
kill, swap, or delete; any `ttlMemo`/`Map` in `apps/api/src` whose staleness can
change a decision, when the API runs more than one replica.

**Incident:** 2026-09-25, dev, config releases (PR #7403 follow-up, fix #7699).
`convergeConfigRelease` checked `turnInFlight` once, then spent 2 413-4 041 ms
fetching and 3 530-6 071 ms extracting the release before `reloadVerified` killed
the live OpenCode. A prompt that arrived in that window started a turn on the
process the swap then killed: the client got `HTTP 503` 10.36 s after sending and
the assistant row stayed `completed = null`, with no text and no parts, for as
long as it was observed. The enabling cause was the second half of the rule —
`desiredMemo` in `turn-start-convergence.ts` was dropped only in the pod that
handled the push, so the other pod answered `current` for a box that was behind.
Dev only; no production impact.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/verified-reload-late-turn.e2e.test.ts`
(real processes: `mayPromote:false` retires the candidate and the incumbent keeps
its pid), `src/__tests__/config-release-converge.test.ts` ("the late turn is
caught before the swap"),
`apps/api/src/projects/lib/__tests__/turn-start-convergence-cross-process.test.ts`
(two independent caches, one bus),
`apps/api/src/shared/__tests__/integration-pg-broadcast.test.ts` (the same over
real PostgreSQL), and flow `CFG-12`, which lands a prompt inside the window on a
real box both by racing it and by parking the convergence with
`?delay_before_swap_ms`.
