---
recorded: 2026-09-26T17:13:21Z
incident_date: 2026-09-26
---
# Run the install lanes on a dependency bump before it merges into main

**Rule:** Never merge a dependency bump into `main` until `pnpm install --frozen-lockfile` has passed on its head. A plain pull request into `main` skips the Tests lanes, so a bot PR can look green while its `package.json` and the root `pnpm-lock.yaml` disagree. Check with `pnpm install --frozen-lockfile --lockfile-only --ignore-scripts`, or let the `test` label run the lanes.

**Trigger surface:** Merging a Dependabot PR (or any PR) that edits a workspace `package.json` without touching `pnpm-lock.yaml`, especially a manifest in a sub-directory such as `apps/mobile`.

**Incident:** 2026-09-26. #7518 bumped `mermaid` in `apps/mobile/package.json` only. Its PR checks were green because Tests did not run. After the squash merge, every Tests lane on `main` failed at "Install workspace dependencies" with `ERR_PNPM_OUTDATED_LOCKFILE`. Reverted in #7749 about 10 minutes later. No deploy shipped a broken artifact; Deploy Dev runs for the window were superseded.

**Enforcement:** `.github/dependabot.yml` labels every npm Dependabot PR `test`, so the six Tests lanes, which install with `--frozen-lockfile`, run before merge. No required status check: the lanes make the failure visible, the merger acts on it.
