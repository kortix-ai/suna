# Convergent runtime — the image is a cache, not the truth

**Status:** implementing · **Date:** 2026-08-20

## The problem

A sandbox runs the code that was baked into its image. Restart and resume
suspend/resume the same VM; a warm fork adopts a captured disk. None of them
re-run the image build. So a box provisioned this morning runs this morning's
`kortix-agent`, this morning's `opencode`, and this morning's CLI — forever.

Two consequences we are paying for today:

1. **Fleet-wide gates.** The ~1,700-LOC wire-id placement machine cannot be
   deleted until every 1.17.11 box drains, because the old OpenCode needs it.
   Correctness work is blocked on VM turnover.
2. **Rebuild storms.** `OPENCODE_VERSION` is part of the snapshot identity, so
   one version bump invalidates every template at once. That is the shape of
   the 2026-07-22 mutual-rebuild loop and the Daytona 429 incident.

`runtime-assets.ts` already solved this — for two assets. It converges
`/usr/local/bin/kortix` and `/opt/kortix/managed-skills` against
`GET /v1/runtime-assets/manifest`: digest compare, download only on mismatch,
verify before replace, atomic rename, never throw, off the readiness path.

It does not cover the `kortix-agent` daemon or the `opencode` binary. That gap
is the entire reason stale boxes exist.

## The principle

> The image is a **cache**. The API a box talks to is the **truth**. A box
> converges onto that truth on every start, and reports what it converged to.

Two corollaries that shape every decision below:

- **A current box downloads nothing.** Digests match, convergence is a no-op.
  Only a stale box pays, and a stale box is exactly the one that is wrong today.
- **Converge on the API you talk to** — never on "global latest". Dev runs three
  regions; two concurrently-live API versions must never make a box oscillate.

## Components

| Component | Size | Served from | Swap safety |
|---|---|---|---|
| `agent` (`kortix-agent`) | ~95.6 MB | Kortix API | supervisor, boot-only |
| `cli` (`kortix`) | ~104 MB | Kortix API | atomic rename, live-safe |
| `opencode` (+ matching `@opencode-ai/plugin`) | ~167 MB | npm registry | idle-only, restarts opencode |
| `managed-skills` | small | Kortix API | staged dir swap |

`opencode` is fetched from npm by the daemon, not proxied through our API: the
manifest states the *expected version*, and 167 MB per stale box has no business
crossing our own control plane.

## Manifest — additive, never reshaped

Existing deployed daemons read `cli_sha256` / `cli_size` / `managed_skills_hash`
off this document. Removing or renaming any of them breaks every box already in
the field, which is the same failure mode as the accept-encoding two-list
divergence. **The v1 keys are permanent.** New daemons prefer `components`;
old daemons keep working because their keys are still there.

```jsonc
{
  // v1 — load-bearing for already-deployed daemons. Never remove.
  "cli_version": "0.13.1-dev.abc1234",
  "cli_sha256": "…",
  "cli_size": 104233088,
  "managed_skills_hash": "…",
  "managed_skills_count": 42,

  // v2 — additive.
  "build": 1755700000,          // monotonic. A box only ever moves forward.
  "components": {
    "agent":    { "version": "…", "sha256": "…", "size": 95606912, "path": "/v1/runtime-assets/agent" },
    "cli":      { "version": "…", "sha256": "…", "size": 104233088, "path": "/v1/runtime-assets/cli" },
    "opencode": { "version": "1.18.19", "source": "npm" },
    "managed-skills": { "hash": "…", "count": 42 }
  },
  "policy": {
    "agent_self_update": true   // kill switch: flip false to stop a bad rollout
                                // WITHOUT shipping a new daemon to boxes that
                                // may no longer boot.
  }
}
```

### `build` is the anti-flap guard

The box records the highest `build` it has converged to. A manifest with a lower
`build` is ignored. During a rolling deploy two API versions serve two manifests;
without this a box ping-pongs between them, re-downloading ~200 MB each way. We
have already lived this once with warm images (2026-07-22, infinite mutual
rebuild).

## Self-update: the supervisor owns the swap

`apps/sandbox/entrypoint.sh` supervises `/usr/local/bin/kortixd`. The daemon
returns exit code `75` when a verified update is ready. The entrypoint then
performs the swap and restarts the daemon.

### The baked binary is an immutable floor

`/usr/local/bin/kortixd` is **root-owned**, and the daemon runs as `kortix`
after the privilege drop. That is not an obstacle to work around — it is the
safety property. Updates are therefore installed *beside* it:

| Path | Owner | Role |
|---|---|---|
| `/usr/local/bin/kortixd` | root | baked floor; runtime code cannot write it |
| `/opt/kortix/agent.current` | kortix | the updated binary, when one is installed |
| `/opt/kortix/agent.next` | kortix | staged by the daemon, promoted at next start |
| `/opt/kortix/agent.prev` | kortix | previous `agent.current`, for rollback |
| `/opt/kortix/agent.pinned` | kortix | latch: rollback happened, stop updating |

The supervisor launches `agent.current` when it is present and executable, and
the baked binary otherwise. Worst-case recovery is therefore *deleting one file*,
after which the box boots exactly what shipped in the image. A bricked box is
not merely unlikely; there is no write path to the floor.

So the daemon **never** replaces itself. It only *stages*:

1. Daemon downloads the new agent, verifies the digest, writes
   `/opt/kortix/agent.next` (+ `.sha256`), and does nothing else.
2. When it is safe to restart (see below) the daemon exits with code **`75`**
   (`EX_TEMPFAIL`) — "replace me and start me again".
3. The supervising entrypoint loop:
   - re-verifies `agent.next` against its recorded digest (the daemon that wrote
     it is not trusted to have been correct);
   - copies the live binary to `/opt/kortix/agent.prev`;
   - atomically renames `agent.next` into place;
   - relaunches.
4. If the new binary exits early **twice in a row**, the supervisor restores
   `agent.prev`, writes `/opt/kortix/agent.pinned`, and stops updating. A pinned
   box keeps running the last binary that worked.

The image-baked binary is the permanent floor: `agent.prev` is only ever a
previously-running binary, and a box with neither still boots the baked one.

### Why a sentinel exit code and not a signal

The supervisor must distinguish "swap requested" from "crashed". Exit 75 is
requested-and-intentional; anything else counts toward the failure budget that
triggers rollback. A crash-looping *new* binary therefore rolls back, while a
crash-looping *old* binary does not silently trigger an update.

## When a swap is allowed

Never mid-turn. The daemon owns opencode's lifecycle, the reverse proxy, and
PTYs; restarting it severs a live turn, and restarting opencode severs the model
call.

- **agent** — staged any time; the restart is requested only when no turn is in
  flight. If the box is busy, the staged binary simply takes effect at the next
  natural restart, which for a sandbox is soon.
- **opencode** — installed only when idle, and the matching
  `@opencode-ai/plugin` pin in the config dir is refreshed in the same step. If
  the plugin does not match the binary, opencode refetches it on every boot,
  which is the multi-second `opencode-session-created` stall.

## Observability — convergence you can query

Auto-update without reporting just moves the uncertainty. `/kortix/health` gains
a `runtime` block:

```jsonc
"runtime": {
  "build": 1755700000,          // what this box converged to
  "components": {
    "agent":    { "installed": "…", "expected": "…", "current": true },
    "opencode": { "installed": "1.18.19", "expected": "1.18.19", "current": true },
    "cli":      { "installed": "…", "expected": "…", "current": true }
  },
  "pinned": false               // rollback latched
}
```

This is what makes "is the fleet current?" answerable instead of hopeful, and it
is the signal that tells us when a fleet-drain gate has actually cleared.

## Security

The daemon runs as root and this is a remote-code-execution channel by
construction. Controls, in order of how much they carry:

- Transport is TLS to an authenticated Kortix API; the token is the sandbox's.
- Every artifact is verified by **sha256 against the manifest** before it is
  moved into place, and the supervisor **re-verifies** independently of the
  daemon.
- Downloads land in a temp file in the destination directory and arrive by
  atomic `rename`; no consumer can observe a half-written binary.
- `policy.agent_self_update: false` stops a rollout centrally.

**Known gap, deliberately stated:** digest-from-the-API is integrity against
corruption and truncation, not against a compromised API. Signing artifacts
against a public key baked into the image is the next increment — the verifier
is already a single choke point (`verifyArtifact`) so the upgrade is additive.
This is written down rather than implied so nobody mistakes the current
guarantee for a stronger one.

## What this unlocks

- **Gate 2 on the wire-id deletion disappears.** Boxes converge to 1.18.19 on
  their next start instead of waiting for VM turnover.
- `OPENCODE_VERSION` can eventually leave the snapshot identity, ending
  full-fleet template rebuilds on every bump. Identity stays as the *cache key*
  for fast boots; convergence is what guarantees correctness.
- The daemon becomes the unit that makes any machine a Kortix machine, which is
  the shape self-host and BYO-compute need. Those will want
  `policy.agent_self_update: false` and a pinned version, which the kill switch
  already expresses.

## Non-goals for this change

- Signing (designed for, not implemented — see Security).
- Channels (`stable` / `latest` / `pinned`) for self-host. The policy block is
  where they will go.
- Removing `OPENCODE_VERSION` from the snapshot identity. Convergence has to be
  proven in the fleet first.
