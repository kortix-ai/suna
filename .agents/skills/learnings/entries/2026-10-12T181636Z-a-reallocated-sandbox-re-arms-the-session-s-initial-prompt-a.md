---
recorded: 2026-10-12T18:16:36Z
incident_date: 2026-10-12
---
# A reallocated sandbox re-arms the session's initial prompt; a retry after provider capacity must not drop the first turn

**Rule:** Any path that deletes a failed sandbox row and allocates a new one for a session that has not run yet must carry the session's `initial_prompt` as a `delivering` turn on the new row. The daemon claims the first prompt only from that turn. Test a new reallocation path with a session whose first allocation fails.

**Trigger surface:** Changing `apps/api/src/projects/session-open/` (allocation, `retryTransientProvisionFailure`, `allocateRuntimeOnOpen`), provider capacity handling, or how the first turn reaches the daemon.

**Incident:** 2026-10-12, release gate rehearsals against staging at v0.13.56. Flows RUN-2, RUN-14-pi, RUN-6-pi, SESS-10 and others timed out waiting for the boot prompt's turn to end. Their artifacts showed `message_count: 0` and `turns: []`: after "provider at capacity" on the first start, the retry reallocated the box with no initial turn, so the session came up idle and the user's first message never ran. The same code serves prod, so a prod session whose first allocation hits provider capacity loses its first message the same way. For weeks this class read as "boot-prompt flake" on the gate.

**Enforcement:** `apps/api/src/projects/session-open/reallocate-keeps-initial-prompt.test.ts` fails if the reallocation drops the initial turn. The gate flows RUN-* and SESS-10 exercise it against deployed staging.
