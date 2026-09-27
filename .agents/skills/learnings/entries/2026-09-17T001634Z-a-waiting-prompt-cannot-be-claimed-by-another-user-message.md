---
recorded: 2026-09-17T00:16:34Z
incident_date: 2026-09-17
commit: cea48e1b66
---
# A waiting prompt cannot be claimed by another user message

An SSE update to a running user message arrived after its optimistic copy was
confirmed. The sync store treated the sole remaining optimistic message as that
update's echo. The waiting Quick Queue bubble vanished while its durable inbox
row remained `waiting`, then returned after reload.

Check whether a user message ID is already in the transcript before matching
optimistic sends. An inbox-backed prompt can be superseded only by its own ID,
part ID, or the inbox row's explicit re-mint alias. Do not use ordinal fallback
for an inbox-backed prompt. `sync-store.test.ts` covers repeated updates,
unrelated echoes, runtime reads, and delayed aliases.

An active turn can finish one assistant step while it continues to work. A
completed assistant message alone does not make that turn idle. Keep the busy
indicator on the turn named by the working projection. Otherwise a trailing
Thinking row appears below a waiting Quick Queue prompt. `working-turn.test.ts`
covers that boundary.
