---
recorded: 2026-09-04T12:48:23Z
incident_date: 2026-09-04
commit: b63e0e0e33
---
# A persistent environment needs a self-healer on its own box, and a preview fix on a feature branch is inert

`pi.kortix.com` — the `pi-worker` branch environment, one Platinum sandbox
reused across every push — answered Cloudflare 502 for hours on three separate
days, each time for a reason the deploy could not repair once it had returned:

1. **Disk.** Every deploy pulls ~2.5 GB of new images and nothing pruned the
   superseded ones. At 100% `supabase-db` crash-loops on `could not write lock
   file "postmaster.pid": No space left on device`. Measured: 64 images, 34 GB,
   25 GB unreferenced, 0 bytes free.
2. **A failed deploy leaves nothing serving.** The bootstrap's retry runs
   `compose down`, the second `up` fails the same way, the script exits, and
   every container stays in `Created`. The hostname guard correctly refuses to
   re-point at a dead stack — but the stack it keeps pointing at IS that box.
3. **Checkout.** A reused sandbox keeps the rootfs of the template it came
   from, so `pnpm install --offline` dies the day the branch adds a dependency
   (`ERR_PNPM_NO_OFFLINE_TARBALL` on `@earendil-works/pi-agent-core`).

The part that made every one of these last for hours: **fixes committed on the
branch did nothing where it mattered.** `deploy-preview.yml` is
`pull_request_target`, and its deploy job checks out the DEFAULT branch, so the
BOOTSTRAP (`buildPreviewBootstrapScript`, written to the box as
`run-kortix-preview.sh`) always comes from `main`'s `tests/`. The bootstrap
then runs `bun tests/bin/preview-stack.ts` INSIDE the box, from the PR-head
checkout at `/workspace/suna` — so the Caddyfile and the compose overlay come
from the BRANCH. Two provenances, verified on the first deploy after this
landed: the guard install and `disk before pull` (bootstrap, main) ran, while
the generated Caddyfile still lacked `swap_tolerant` (preview-stack, branch)
until the guard patched it 60 s later. Know which file you are changing:
`sandbox-preview.ts` → main; `preview-stack.ts` → the branch under test, and
main only after the branch merges main.

**The rules.**

1. **A change to `sandbox-preview.ts` or `deploy-preview.yml` reaches a
   preview only from `main`; a change to `preview-stack.ts` reaches it from
   the branch being deployed.** Land bootstrap and workflow fixes on `main`
   first, in their own PR; put Caddyfile and overlay fixes on the branch (and
   on `main`, or the next branch loses them).
2. **A persistent environment carries its own watcher.** The deploy is on the
   box for ~14 minutes a day; the environment is expected to serve for the
   other 1,426. `tests/src/core/preview-guard.ts` runs as a container on the
   sandbox: prunes unreferenced images when the disk passes 75%, brings the
   stack back up when the edge stops answering and no deploy is in flight, and
   keeps Caddy swap-tolerant. It never runs `down -v`. Installed on every
   deploy, keyed on its own hash, so a recreated sandbox gets it too. Proven
   by hand on pi.kortix.com before it was committed: installed at 12:41:40,
   recovered the dead stack at 12:43:27, Caddy patched at 12:44:27.
3. **A deploy that cannot bring the new stack up puts the last good one
   back.** The health check saves the proven `.env` (image tags) to
   `last-good.env`; a stack failure restores it and runs `compose up` before
   exiting 1. The deploy still fails; the name keeps answering.
4. **Removing the `preview` label deletes the environment and its data.**
   That is the design (the label is the off switch), but re-adding it creates
   an EMPTY environment: new sandbox id, fresh Postgres, no accounts, no
   projects, no git mirrors. On 2026-09-03 10:19 the label was toggled off and
   on; the test account and the `pi-lab` project stopped existing.

*Fix:* this entry's PR — `preview-guard.ts`, the bootstrap changes, the two
preview-parity ports. *Enforcer:* `tests/unit/preview-guard.test.ts`
(`sh -n` on the guard, never `-v`, deploy-in-flight gate, hash-keyed install)
and `tests/unit/sandbox-preview.test.ts` (prune before pull, fallback install,
rollback after the health check, guard before configure).
