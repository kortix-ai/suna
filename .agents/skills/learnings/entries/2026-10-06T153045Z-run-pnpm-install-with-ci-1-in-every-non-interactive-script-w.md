---
recorded: 2026-10-06T15:30:45Z
incident_date: 2026-10-06
---
# Run pnpm install with CI=1 in every non-interactive script: without a TTY it stops at the modules-purge prompt and exits 0 having installed nothing

**Rule:** Every script that runs `pnpm install` without a terminal sets
`CI=1` (or `CI=true`), and asserts afterwards that a workspace link it needs
exists. Do not trust the exit code alone.

**Trigger surface:** writing or editing a deploy, preview, bootstrap or
worktree script that installs dependencies over SSH, `exec`, cron or CI.

**Incident:** 2026-10-06, the pi-js branch environment
(`kortix-env-pi-worker-js`). After a branch switch, pnpm wanted to purge and
reinstall a modules directory and printed "Proceed? (Y/n)". With no TTY it
gave up, installed nothing, and exited 0. The next step failed far away from
the cause: `bun apps/cli/src/index.ts self-host init` →
`Cannot find module '@kortix/manifest-schema/layout'`. The CI preview host
script already exports `CI=1`; the hand-written redeploy did not.

**Enforcement:** `apps/pi-worker-js/env/pi-js-host.sh` exports `CI=1` and
fails when `packages/registry/node_modules/@kortix/manifest-schema` is missing
after install. None yet for other scripts: a shared install helper would be
the enforcer.
