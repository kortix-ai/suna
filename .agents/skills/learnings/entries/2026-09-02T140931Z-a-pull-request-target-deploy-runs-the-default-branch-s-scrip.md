---
recorded: 2026-09-02T14:09:31Z
incident_date: 2026-09-02
commit: c5fc7d4c52
---
# A `pull_request_target` deploy runs the DEFAULT BRANCH's scripts, so a fix to the deploy path is dark until it reaches main

**When:** changing anything under `tests/src/core/sandbox-preview.ts`,
`tests/bin/preview-stack.ts`, or the Caddy/compose templates a preview
generates, and then testing it by pushing to the branch that owns the preview.
`deploy-preview.yml` is `pull_request_target`; its build jobs check out
`needs.authorize.outputs.sha` (your commit) but the **deploy job checks out
`${{ github.event.repository.default_branch }}`**. So the images are yours and
the deploy logic is main's. A push proves nothing about a deploy-script change,
and the change cannot fail loudly — it simply never runs.

**The incident:** a branch environment is REUSED, so nothing reclaims the images
each deploy supersedes; ~3 GB of api/frontend/gateway layers accumulate on a
50 GB disk. A prune was written on `pi-worker` weeks earlier and never took
effect, because the deploy reads main. pi.kortix.com reached 100% / 0 avail:
`supabase-db` crash-looped on `could not write lock file "postmaster.pid": No
space left on device`, `supabase-kong` restarted, `preview-edge` and 12 other
services stayed in `Created`, and the deploy's own health gate then refused to
re-point the hostname — correctly — leaving a 502 for ~30 min. 22.2 GB pruned
by hand restored it (100% -> 54%).

**The second rule, from the same incident: never gate a cleanup behind the
health it protects.** The prune ran only AFTER the new stack proved healthy,
which is exactly the state a full disk prevents — the cleanup sat behind the
failure it existed to prevent. Reclaim before the pull as well, gated on the
disk actually being tight (`image prune -af` spares every image a container
references, running or not).

**Diagnostic:** `x-kortix-environment: pi` present on a Cloudflare 502 means the
Worker is healthy and passing an upstream failure through; the sandbox origin
answering `upstream-unreachable: Failed to connect` means nothing is listening
on 8080. Then `df -h /` inside the box, not the deploy log.
*Enforcer:* none. A check that a PR touching the preview deploy path is on
main before it is trusted, or a disk-usage assertion in the deploy summary,
is the TODO.
