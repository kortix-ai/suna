---
recorded: 2026-09-06T03:06:42Z
incident_date: 2026-09-04
commit: 3caec60726
---
# Optimistic UI is not durable — the queue row must carry what the UI redraws

**When:** a client paints a send before the server confirms it. A reload throws
that state away, so anything the bubble needs must live on the durable row. The
prompt row carried `text` and nothing else, so a refreshed tab rendered a send
of seven attachments as a bare sentence with no tiles — indistinguishable from
a prompt that never had files, while the upload was in fact still in flight.
**The rule:** every field the optimistic bubble draws has a durable counterpart
on the queue row, and the reload path reads it. Names and MIME types only —
that view is POLLED, so shipping the `data:` bytes would re-send megabytes per
tick. *Enforcer:* `session-prompt-view.test.ts` ("names every attachment
without carrying its bytes"), `optimistic-turn.test.tsx` ("draws a pending tile
per staged attachment after a reload").
