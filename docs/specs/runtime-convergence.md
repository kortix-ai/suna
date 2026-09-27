# Runtime convergence: a session runs the current runtime, or it does not run

This is the contract that makes one promise true:

> With `config_releases` on, a session runs the project's **current** config
> release and the platform's **current** runtime. A box that cannot prove it
> does is repaired or replaced. It is never kept quietly on something older,
> and no failure is ever permanent.

`docs/specs/config-releases.md` specifies the config release itself — how it is
built, stored, served and proven. This file specifies the *convergence*: how
every runtime input a session depends on is kept current for as long as the
session lives, and what the platform does when one cannot be.

## 1. Why this exists: five failures, one shape

Measured on real dev boxes on 2026-09-26, all in one project:

| # | What happened | The terminal state |
| - | - | - |
| 1 | A box's only managed-model fetch failed at boot: `[boot] managed reconcile: no live managed set; bundled managed models stand` | The daemon's **bundled** lineup became the box's lineup forever |
| 2 | A config release candidate was SIGTERMed by the daemon's own `agent-swap` shutdown 815 ms after spawn | The release was recorded as failed and **quarantined on that box** |
| 3 | `CLI replace failed: EACCES: permission denied, open '/usr/local/bin/…'` on a box whose daemon runs non-root | `cli: "failed"`, retried every reconcile, forever |
| 4 | `agent swap deferred — live work in progress {"name":"pty"}` because one shell was left open | The daemon never updates, so the box never gains any capability we ship |
| 5 | A Platinum box is suspended and resumed, not rebooted (`uptime_s: 2663144` — 30.8 days) | Every boot-time-only decision above is never re-taken |

They are the same defect wearing five costumes: **a one-shot decision, taken
once under whatever conditions happened to hold, that hardens into a state
nothing re-derives.**

The user-visible end state of that chain, also measured: the platform lineup
rotated, and the affected box then had **no model both sides would accept** —
the API rejects the ids the box knows (`400 INVALID_SESSION_MODEL`), the box
does not have the ids the API serves, and every prompt returned `500
UnknownError`. Restarting the session did not help. Only creating a new session
did.

Fixing the five individually leaves the shape intact and the sixth costume
arrives next month. This spec removes the shape.

## 2. The four rules

### Rule 1 — one desired-state document, one actual-state document

The API computes, per session, a single **desired runtime** document:

```
release_id            the config release for (project, base ref, agent)
catalog_fingerprint   hash of the managed lineup the platform serves
daemon_build          the runtime-asset build the platform ships
cli_sha256            the Kortix CLI the platform ships
managed_skills_hash   the managed-skill overlay the platform ships
```

The box reports the same five fields as **actual**. Convergence is the diff of
two documents, computed in one place. No component may hold a private opinion
about whether it is current: a component that cannot report its actual value
reports `unknown`, which is a diff, not a pass.

This replaces today's arrangement, where config releases, runtime assets and
the model catalog each decide for themselves, in different code, at different
moments, with different failure handling — and the model catalog decides only
once.

### Rule 2 — no terminal states

Every failure is a **timestamped attempt**, never a verdict.

- A component that fails records `{ attempted_at, cause, attempts }` and stays
  in the diff. It is retried on the next tick.
- **Quarantine requires evidence that the release itself is at fault** — the
  candidate started and answered with a config error, or failed its proof. A
  candidate that died because the daemon exited, the box suspended, or the
  supervisor restarted it is *not* evidence, and must leave the release
  un-quarantined.
- Every quarantine carries an expiry and is re-derived on a new daemon build, a
  new release id, or after `QUARANTINE_TTL`. A release the platform still
  declares desired is retried eventually, always.
- A component that can *never* succeed in its current environment (rule 2's
  honest case, e.g. an unwritable install path) escalates: it reports
  `blocked` with the cause, the API surfaces it, and the box is marked for
  replacement rather than retried in silence forever.

### Rule 3 — convergence is continuous, not boot-time

A reconcile tick runs on **all** of:

1. boot;
2. **resume** — detected by comparing wall-clock elapsed against monotonic
   process uptime, because a suspended box resumes with its processes intact
   and never re-runs boot;
3. turn start, through the existing chokepoint
   (`apps/api/src/projects/lib/turn-start-convergence.ts`);
4. a periodic floor while the box is alive.

The asymmetry from `apps/api/src/runtime-assets/manifest.ts` still governs what
a tick may *block*: config blocks the turn, binaries never do, and the model
catalog blocks only when the turn's own model is missing from the box's map.

**Two lanes may not race.** A convergence in flight is a swap blocker, and a
swap in flight defers a convergence. Whichever runs second re-reads the desired
document rather than acting on what it read before.

A tripwire test forbids new boot-only convergence code: any call that
materializes runtime state must be reachable from the tick, not only from boot.

### Rule 4 — admission control makes "every new session is fresh" true

Today nothing checks what a box *is* before a session is handed to it. A
session can be placed on a pooled or resumed box whose daemon predates every
capability the feature needs, and the session inherits that permanently.

So: before a box is handed to a session, it must prove its runtime identity —
`config.release.v1` present, `daemon_build >= floor`, `catalog_fingerprint`
current. A box that fails admission is **replaced, not used**. The floor is a
constant in the API, raised deliberately, never read from the box.

This is the rule that makes the promise at the top of this file hold for every
session started from the moment it ships, independent of every box that already
exists.

## 3. What the user and the operator see

One `runtime` block on `GET /v1/projects/:projectId/sessions/:sessionId/config`,
listing desired vs actual per component with each component's last attempt and
cause. The session header chip reads from that block. Three states only:

- **current** — every component matches;
- **converging** — at least one differs, with a live attempt;
- **blocked** — a component reports `blocked`, with its cause in plain words.

A turn that cannot run because the box lacks the requested model fails with an
error that **names that cause** and carries the fingerprints. `500
UnknownError` is a bug, not a state.

## 4. Acceptance

The contract is met when, on a real box, each of these self-heals without human
action and the session state says so while it happens:

1. the catalog fetch fails at boot, then a later tick makes the box current;
2. a release candidate is killed by an asset swap, and the release is NOT
   quarantined and succeeds on the next tick;
3. a box resumes after days suspended and converges without a new session;
4. a box that cannot converge (unwritable install path, capability below the
   floor) reports `blocked` and is not handed to a new session;
5. a turn whose model is missing from the box's map either converges and runs,
   or fails with an error naming the cause.

Each is a flow in `tests/spec/end-to-end.md`, exercised on a deployed target —
the local profile cannot boot a sandbox, so a green local run proves none of
this.
