---
recorded: 2026-08-14T14:36:43Z
incident_date: 2026-08-14
commit: e7f376ef00
---
# A control split across API and daemon is only live when BOTH halves are

**When:** shipping any security control whose two halves live in `apps/api` and
`apps/kortix-sandbox-agent-server`. The API half goes live the moment Deploy Dev
finishes. The daemon half does NOT: it is baked into the sandbox image, reaches
a guest only through a new meta-snapshot build, and the fingerprint that
triggers that build hashes `apps/kortix-sandbox-agent-server/src`. Until an
image carrying the new daemon exists, the API half is running against old
guests and the control does nothing.

The sandbox egress pin hit this exactly: the API mount was verifiably live
(boot-timeline went 403 → 401 on the same request), but a real exfiltrated-token
attack still SUCCEEDED because the box's baked daemon still sent the wrong
token, so nothing wrote a pin. The identical test passed later, unchanged, once
a sandbox with the new daemon existed.

Two rules:

- **Never conclude "the control does not work" from one post-deploy run.** Prove
  which half is live first. An API-side before/after on the same request is
  cheap and decisive (`403 handler-guard` → `401 middleware`).
- **A control that fails OPEN is the right default while it propagates** — the
  pin allows `unpinned`, so old guests kept working and nothing regressed
  during the lag. A fail-closed control shipped this way is an outage.

Do not read a fast `session_start_timeline.totalMs` as proof of a warm-pool box
either: `KORTIX_WARM_SNAPSHOT_ENABLED` defaults false, and ~2s is also what
creating a container from an ALREADY-BUILT image costs.
*Incident:* the token-binding verification failed twice before the image landed.
