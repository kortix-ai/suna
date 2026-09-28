---
recorded: 2026-09-28T04:09:40Z
incident_date: 2026-09-28
---
# Admission refusal must replace the runtime, never route through the park/preserve helper

**Rule:** A helper that parks or preserves an established runtime (stops the
session, `stage:'failed'`) is for a box that is BROKEN. A box that is merely
unserviceable by policy (fails a point-in-time admission/capability check but
is still running fine) must be REPLACED on the same session, never parked.
Route each population through the function whose contract actually matches
it; do not reuse a park/preserve helper for a new population just because the
call site is already there — give the new population its own function.

**Trigger surface:** Adding a new refusal/rejection reason to a session-open
chokepoint (`runOpenSession` in `apps/api/src/projects/routes/shared.ts`) that
already has an established-runtime failure helper in scope. Also: any time a
kill-switched enforcement flag exists — the wrong wiring is invisible while
the flag is off, so review it as if the flag were already on.

**Incident:** near-miss, caught before `RUNTIME_ADMISSION_ENFORCE` was ever
turned on. The Rule 4 runtime-convergence contract says an admission-refused
box "is replaced, not used," but the implementation routed refusals through
`preserveEstablishedRuntimeOnOpen`, which parks (`stage:'failed'`) or preserves
as lost (`RUNTIME_IDENTITY_UNAVAILABLE`) — never replaces. One real project had
152 of 235 sandboxed sessions provisioned before a boot-time LLM-gateway
credential existed; those boxes can never pass admission and can never
self-heal via convergence (convergence itself needs the missing credential).
Flipping the enforcement flag as originally wired would have parked all 152 as
terminal, unrecoverable-by-the-user failures in one pass. Fixed by adding
`retireRefusedRuntime` (runtime-identity.ts) and `replaceRefusedRuntimeOnOpen`
(routes/shared.ts): retire the box, allocate a fresh one on the same session,
bounded to `ADMISSION_REPLACE_MAX_PER_WINDOW` (3) replacements per
`ADMISSION_REPLACE_WINDOW_MS` (15 min), counted on `project_sessions.metadata`
because replacement deletes the sandbox row the old counter would have lived
on. Never pulls a box out from under a live turn
(`sessionHoldsTurnAuthority`).

**Enforcement:** `apps/api/src/projects/runtime-identity-replace-refused.test.ts`
(retire claims/stops/deletes correctly, never touches a serving box),
`apps/api/src/projects/routes/replace-refused-runtime-on-open.test.ts` (refusal
on a running box yields `stage:'provisioning'`/`'starting'`, `retriable:true`,
never `'failed'` with `RUNTIME_IDENTITY_UNAVAILABLE`), and
`apps/api/src/projects/routes/preserve-established-runtime-on-open.test.ts`
(the four pre-existing park/preserve populations are unchanged).
