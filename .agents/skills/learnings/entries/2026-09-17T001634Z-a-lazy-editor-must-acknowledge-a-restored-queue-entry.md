---
recorded: 2026-09-17T00:16:34Z
incident_date: 2026-09-16
commit: cea48e1b66
---
# A lazy editor must acknowledge a restored queue entry

**Incident.** The deployed queue journey selected Edit during startup handoff.
SessionChat cleared the shared prefill in a parent effect before its lazy editor
could apply it. The outgoing and incoming composers were also both accessible.

**Rule.** Clear a prefill only after the editor reports application of that ID.
An older acknowledgement must not clear a newer edit. Mark the inactive startup
layer inert and hidden from assistive technology during the transition.

**Enforcer.** `session-composer-prefill-store.test.ts` protects newer edits from
stale acknowledgements. The deployed queue journey edits during startup and
asserts the restored text through the one accessible Message input.
