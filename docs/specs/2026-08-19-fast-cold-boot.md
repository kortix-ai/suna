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

This design creates no sandbox pool. It adds no database state. It changes no
Git history or push behavior.

## Rollback

Set `KORTIX_FAST_COLD_BOOT_ENABLED=false` and redeploy the API. The API then
omits all three hints, and the daemon uses the previous network path.

## Verification

The sandbox regression test materialized an exact scaffold-plus-bundle checkout
in 79 ms. It observed zero clone-credential requests and verified the resulting
branch, content, and commit. The current managed starter's bundle stays below
the 24 KiB delivery cap.

The deployed dev benchmark must compare at least five cold sessions after the
API and sandbox image contain the same merged commit.
