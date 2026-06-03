# Warm Sandbox Pool

The warm sandbox pool keeps a bounded number of pre-booted, unclaimed sandboxes
per active project so a new session can claim an already-running box instead of
starting from a cold provider create.

## Runtime Model

- Warm pool rows live in `session_sandboxes`.
- Normal session rows have `pool_state = null`.
- Warm rows move through `booting -> parked -> claimed`.
- A `parked` row is claimable and has no `project_sessions` row yet.
- Claiming a row clears `pool_state`, inserts the matching `project_sessions`
  row, and lets normal session lifecycle handling take over.

The preallocated sandbox id is also the future session id. This preserves the
existing `sandbox_id == session_id == branch` invariant after the claim.

## Controls

- `KORTIX_WARM_POOL_SIZE` sets the operator default per active project.
- `KORTIX_WARM_POOL_MAX_TOTAL` caps all unclaimed warm boxes fleet-wide.
- Setting `KORTIX_WARM_POOL_MAX_TOTAL=0` disables the pool.
- `KORTIX_WARM_POOL_PRESENCE_MINUTES` bounds how long recent user presence keeps
  a project eligible for refill.

Per-project UI state is stored in `projects.metadata.warm_pool`.
Presence is stored in `projects.metadata.warm_pool_seen_at`.

## Maintenance

The project maintenance sweep refills eligible projects, reaps stale or failed
warm boxes, and skips hibernation for unclaimed warm rows. Once a warm box is
claimed, its `pool_state` is cleared and it follows normal session hibernation
rules.
