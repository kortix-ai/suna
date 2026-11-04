---
recorded: 2026-11-04T01:50:16Z
incident_date: 2026-11-04
---
# A prompt sent while a turn runs steers that turn; no client, placement or sender picks another delivery mode

**Rule:** The session prompt inbox has one delivery mode. While a turn runs,
the session's head row steers it (`POST .../steer`); the agent reads it after
its current tool call, in the same turn. While no turn runs, the row starts
one. Admission never reads `delivery`, `placement` or who sent the row. Do not
add a mode that holds a prompt for the whole turn, ends the turn for it, or
reorders rows by placement. Stop holds waiting rows only while it settles, then
releases them as the next turn.

**Trigger surface:** Changing `inbox-admission.ts` (`admitInboxPrompt`,
`admitSteer`), `inbox-order.ts`, `deliverSteer`, the `POST .../prompts/hold`
route, or any client that decides how a prompt is sent while the agent works
(web composer, TUI composer, mobile, CLI `--queue`/`--steer`, server producers).

**Incident:** 2026-11-04, prod. A TUI user typed "go on" 2 s into a long
autonomous turn. The TUI wrote a `placement: composer` row (Queue List), and
admission held it `turn_active` for the whole turn. In the same session, three
results from the agent's own subagent arrived as steers and fell back
`not_prompter` (an agent row is never the turn's prompter), so the parent turn
could not read the results it was waiting for. Web, mobile, TUI and CLI each
picked a different default (steer, Queue List, Quick Queue). The same "hold for
the whole turn" behavior was already reverted once on 2026-08-21 (entry "a
comment saying this was tried and reverted is a decision record"). Fixed on
branch `one-prompt-path-steer`: one mode, no prompter rule, no Quick Queue
(`/kortix/abort/after-tool` deleted), one FIFO lane, Stop releases as the next
turn. Verified on a real pi session: a TUI-shaped row went `forwarded` in about
1 s and the turn answered it at its next step without ending.

**Enforcement:** `apps/api/src/projects/session-lifecycle/inbox-admission.test.ts`
("one delivery mode: every row steers a live turn"),
`inbox-order.test.ts` ("one lane"), the "steering (R10)" block of
`apps/api/src/__tests__/integration-prompt-inbox.test.ts`, and
`packages/ui/src/session/composer/queue-projection.test.ts`
("Cmd/Ctrl+Enter sends exactly like Enter").
