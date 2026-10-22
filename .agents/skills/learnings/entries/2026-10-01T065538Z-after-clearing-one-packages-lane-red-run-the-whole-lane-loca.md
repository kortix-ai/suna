---
recorded: 2026-10-01T06:55:38Z
incident_date: 2026-10-01
---
# After clearing one packages-lane red, run the whole lane locally: it stops at the first failing package and hides the next red

**Rule:** When a fix clears a red in the `packages` lane, run `pnpm test -- --packages-only` to the end before you call `main` green. `tests/bin/package-quality.ts` runs its package waves in sequence and stops at the first wave that fails, so every later package goes untested.

**Trigger surface:** Repairing a red `packages` lane on `main`; reading a `packages` lane log that shows one failure.

**Incident:** 2026-10-01. f605a96 (#8559) changed the vendored self-host `docker-compose.yml` without its content lock, and the `@kortix/cli` test failed in wave 3. From then on wave 4 (`@kortix/db` and every other app and package) never ran on `main`. That hid a second red: the `apps/mobile` status-palette parity test, broken since 7e5e3735d4 (#8567) moved web `status.tsx` to brand colors. The lock fix (#8584) alone would have left `packages` red. A full local lane run found the mobile test, and #8578 fixed it. Both had to merge before the staging candidate could go green.

**Enforcement:** none yet. To build: make `package-quality.ts` run every wave and fail at the end with all failures listed.
