---
recorded: 2026-09-17T00:16:34Z
incident_date: 2026-09-17
commit: cea48e1b66
---
# A redelivery must not re-send when its answered check cannot read

A local session settled a running turn `runtime_gone` at 23:08:58 and redelivered
its prompt. The daemon was still running that turn and interrupted it 12s later.
OpenCode's transcript held two replies to the first delivery, so the drain's
already-answered guard would have dropped the redelivery. The guard read the
full transcript with a 5s timeout and failed open, so the prompt ran twice.

A prompt already POSTed once (`deliveryAttempt` or `redeliveries` above zero)
never re-sends on an unreadable transcript. It waits 5s, 10s, then 20s and
counts `answer_check_failures`; after three failures it sends, so an unreadable
box cannot strand it. First deliveries keep the fail-open read. The full read
gets 15s. The daemon's turn-end relay was also failing on a stale tunnel URL,
which leaves the API to infer turn ends by polling.

Enforcement: `queued-continue-inbox-delivery.test.ts` covers the blocked blind
re-send and the bound; `integration-prompt-inbox.test.ts` covers the requeue SQL.
