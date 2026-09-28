---
recorded: 2026-09-01T11:19:34Z
commit: 8328d2adc3
---
# A pnpm override that pins one exact version forks the dependency graph the moment its dependent moves

- **Incident (2026-08-30..31, dev deploy outage):** three consecutive `main`
  deploys (`528ad10a`, `20027210`, `9bfc0685`) failed on `Waiter ServicesStable`
  for `kortix-dev-web`. The frontend container exited 1 at boot with
  `Cannot find module 'next'`. Root override `"next@>=15.0.0 <16.3.0": "16.3.0"`
  mapped `apps/whitelabel-demo`'s declared `next: 15.5.21` onto `16.3.0`. While
  `apps/web` was itself on 16.3.0 both apps shared one resolved package. PR
  #7067 moved `apps/web` to 16.3.3; the override kept whitelabel on 16.3.0, so
  the lockfile resolved TWO `next` packages. The `.next/standalone` trace then
  contained a partial 16.3.0 copy (a `dist/` without `package.json`), and the
  Dockerfile relink loop linked `node_modules/next` to it by sort order. Dev
  served the previous image (`95f60297`) for ~22 hours.
- **Rule:** an override that maps a range to one exact version must move in the
  same commit as the direct dependency it shadows. `--frozen-lockfile` cannot
  catch the drift: it compares the lockfile against post-override specs, so the
  divergence is green in CI and only fails at container boot.
- **Enforcement:** `apps/web/scripts/single-next-version.test.mjs` fails the web
  test suite whenever `pnpm-lock.yaml` resolves more than one version of
  `next`. The override now reads `"next@>=15.0.0 <16.3.3": "16.3.3"` and
  `apps/whitelabel-demo` declares `next: 16.3.3` explicitly.
