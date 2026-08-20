# Fast cold boot experiment

Status: enabled on dev behind `KORTIX_FAST_COLD_BOOT_ENABLED`.

## Problem

A five-session dev sample on 2026-08-20 measured repository materialization at
7,983 ms p50 and 17,251 ms p90. The sandbox image already contains the canonical
starter repository at `/opt/kortix/scaffold.git`, but the API did not send the
fresh-session or base-tip hints that activate its local fast path.

The daemon therefore performed two avoidable network operations:

1. It fetched clone credentials from the API.
2. It fetched the fresh session branch after repository materialization.

For a project whose base tip equals the baked scaffold, it also performed an
unnecessary Git negotiation for zero objects.

Managed projects normally have one customization commit above the deterministic
scaffold. The base-tip equality check cannot remove that project's fetch.

## Design

When `KORTIX_FAST_COLD_BOOT_ENABLED=true`, the API sends these hints for a new
branch workspace:

- `KORTIX_SESSION_FRESH=1`
- `KORTIX_BASE_SHA=<server-resolved base tip>` when SHA resolution completes
  within its existing two-second deadline
- `KORTIX_GIT_DELTA_BUNDLE_BASE64=<bounded exact commit bundle>` when the base
  tip is one commit above its parent and the encoded bundle is at most 24 KiB

After a managed project seed completes, the API stores the verified bundle in
`projects.metadata.git.fast_boot`. A later session validates the cached SHA
against the authoritative remote branch tip before it reuses the bundle. A
missing or stale entry starts a mirror refresh and preserves the authenticated
network fallback.

The cache is available to every API instance. The project serializer removes
the internal `fast_boot` field from provision, list, and detail responses.

The daemon uses the hints as follows:

- A matching scaffold and base tip materialize from local disk.
- A one-commit managed-project tip imports from the API mirror bundle and must
  resolve to `KORTIX_BASE_SHA` before checkout.
- A new session branch is created locally from base.
- Clone credentials resolve only if a network fetch is required.
- A missing SHA, a different base tip, an imported repository, or a local
  scaffold failure uses the existing shallow-clone fallback.
- Restarted sessions keep the existing remote-branch fetch behavior.

The bundle is transported with the sandbox creation environment. The daemon
validates its encoding, size, prerequisite commit, and resulting SHA. Any
validation failure uses the authenticated fetch path.

This design creates no sandbox pool. It requires no schema migration. It changes
no Git history or push behavior.

## Rollback

Set `KORTIX_FAST_COLD_BOOT_ENABLED=false` and redeploy the API. The API then
omits all three hints, and the daemon uses the previous network path.

## Verification

The sandbox regression test materialized an exact scaffold-plus-bundle checkout
in 79 ms. It observed zero clone-credential requests and verified the resulting
branch, content, and commit. The current managed starter's bundle stays below
the 24 KiB delivery cap.

The dev deployment for PR #6650 served merge commit
`de015e17510d52af2165e31a8c9dbf7c69923429`. One image warm-up was excluded,
then five new Platinum sessions ran with `warm_sessions=false` against a new
`general-knowledge-worker` project.

| Milestone | Before | After | Change |
| --- | ---: | ---: | ---: |
| Repository materialized, p50 | 7,983 ms | 265 ms | -96.7% |
| Runtime ready, p50 | 25,000 ms | 18,348 ms | -26.6% |

Three of five sessions imported the bundle and materialized the repository in
257-265 ms. Two sessions exceeded the API's two-second mirror deadline and used
the existing network fallback in 4,910-5,313 ms. The fallback preserved
correctness.

PR #6652 persisted the verified bundle before the first session. Deploy Dev run
`32366930298` deployed merge commit
`9865b3bd6604e26e99acdda9f63f821c71906d88`. Dev health reported that exact
commit. One image warm-up was excluded, then five new Platinum sessions ran with
`warm_sessions=false` against a new `general-knowledge-worker` project.

| Milestone | Before durable cache | After durable cache | Change |
| --- | ---: | ---: | ---: |
| Repository materialized, p50 | 265 ms | 258 ms | -2.6% |
| Repository materialized, max | 5,313 ms | 260 ms | -95.1% |
| Runtime ready, p50 | 18,348 ms | 17,813 ms | -2.9% |
| Runtime ready, max | 24,382 ms | 20,618 ms | -15.4% |

All five sessions imported the bundle. Repository materialization measured
255-260 ms. A separate managed-project provision completed in 10,487 ms. Its
`201` provision response and `200` detail response did not expose `fast_boot`.

Git is no longer the largest in-guest phase for this project type. OpenCode
readiness measured 6,161-8,738 ms after daemon start in the five-session sample.
