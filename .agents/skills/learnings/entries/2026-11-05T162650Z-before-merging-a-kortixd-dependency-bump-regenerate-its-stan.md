---
recorded: 2026-11-05T16:26:50Z
incident_date: 2026-11-05
---
# Before merging a kortixd dependency bump, regenerate its standalone bun.lock and run bun-lock-sync.test.ts

**Rule:** A root `pnpm install` does not touch
`apps/kortix-sandbox-agent-server/bun.lock`. After any change to kortixd's
`package.json`, including a repo-wide version bump, run
`bun install --lockfile-only` in that directory with the image's bun (1.4.3),
commit `bun.lock`, and run `bun test src/__tests__/bun-lock-sync.test.ts` before
merging.

**Trigger surface:** A dependency sweep or override that edits many
`package.json` files at once (a security bump, a major upgrade).

**Incident:** 2026-11-05, #11842 moved every package to zod ^4.6.7 and
regenerated `pnpm-lock.yaml` only. The dev deploy (run 42060629315) failed in
"Build API image (amd64)": the `sandbox-agent` stage's
`bun install --frozen-lockfile` answered "lockfile had changes, but lockfile is
frozen". dev-api stayed on the previous commit. Fixed forward in #11843 about
25 minutes after the merge.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/bun-lock-sync.test.ts`
("bun.lock records the dependency specs package.json declares") goes red on
this exact drift. It runs in the nightly and release lanes, not before a merge
into `dev`, so the author runs it by hand. The sweep ran 45 kortixd test files
chosen by import and missed it.
