---
recorded: 2026-10-21T11:18:14Z
incident_date: 2026-10-21
---
# Run next dev on Turbopack, not webpack: webpack dev ignores every memory control and reached 16 GB per server

**Rule:** Keep `--webpack` off every `next dev` command (`apps/web/package.json` `dev` and `dev:staging-env`, `scripts/dev-local.sh`). Keep `--max-old-space-size=4096` in the `NODE_OPTIONS` of the two `apps/web` scripts (`dev` and `dev:staging-env`). Without the cap, `next dev` sets the server heap cap to 50% of RAM (`next/dist/cli/next-dev.js`), which is 12 GB on a 24 GB Mac. Next restarts the dev server at 80% of the cap, so a lower cap is a lower ceiling. The cloud-sandbox `next dev` in `scripts/dev-local.sh` has no cap. Do not switch the bundler to work around a dependency crash: fix or upgrade the dependency.

**Trigger surface:** Editing a `next dev` command, working around a Turbopack crash, upgrading Next or `fumadocs-mdx`, or a developer Mac that lags with several worktrees running.

**Incident:** 2026-10-21, Next 16.4.0. PR #10453 (KRTX-2751) made webpack the dev default to dodge a `fumadocs-mdx` 15.2.1 unhandled rejection. In webpack mode `turbopackMemoryEviction` and `turbopackGc` do nothing. One webpack `next dev` reached 15 GB in 15 minutes. With two web servers running, a 24 GB Mac had 29.0 of 29.7 GB swap in use and the browser stopped responding. Same worktree, same 8 routes, cold `.next`: webpack 16,522 MB, `/` compiled in 127 s, `/legal` timed out at 240 s. Turbopack: 6,657 MB, `/` in 20.6 s, other routes in ~3 s. The crash fix is `fumadocs-mdx` 15.2.2+, which catches the `createMDX` init rejection (`pending.catch(...)`).

**Enforcement:** `apps/web/scripts/dev-server.test.ts` runs `pnpm dev` and fails unless Next prints `(Turbopack)`.
