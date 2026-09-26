---
recorded: 2026-09-06T03:06:42Z
incident_date: 2026-09-04
commit: 3caec60726
---
# Resolve competing UI sources per FIELD, never first-non-null

**When:** a surface can learn the same thing from several places (local state,
an in-memory producer handoff, a durable row, a stash). The session boot shell
picked its bubble with `submission ?? preview ?? durableRow ?? stash`. The
durable row is the cross-navigation truth for TEXT but never carries the user's
`File`s, so on the commonest navigation — home composer → new session — the row
landed first, won, and dropped three attachments the stash was still holding.
The prompt appeared instantly and its files only reappeared when the runtime
echoed the message, minutes later behind a chunked upload. First-non-null let
the POOREST source win. **The rule:** pick each field from whichever source
actually has it. Also: the bytes reach the box BEFORE the runtime creates the
message, so the optimistic bubble owns the whole upload window and must narrate
it — a tile spinner says "this file", nothing said how many remained or that one
had failed. *Enforcer:* `optimistic-turn.test.tsx` (staged tiles + "Uploading N
files…" + named failure), `uploaded-file-refs.test.ts` (batch weighed from
`File.size` before a byte is read; reads run in parallel).
