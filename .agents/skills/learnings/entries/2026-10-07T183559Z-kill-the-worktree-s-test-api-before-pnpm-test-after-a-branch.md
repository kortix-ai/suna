---
recorded: 2026-10-07T18:35:59Z
incident_date: 2026-10-07
---
# Kill the worktree's test API before pnpm test after a branch switch: the runner reuses any running API with the test profile

**Rule:** After a worktree switches branches, or after an API source edit, stop the worktree's test API before `pnpm test` (find it with `lsof -iTCP:<api port> -sTCP:LISTEN`, for example :18708). `ensureLocalStack` (`tests/src/core/local-stack.ts`) reuses any healthy API on that port that uses the deterministic test profile. It does not check which code that process runs, so API flows can pass or fail against another branch's code. The log line says so: `reusing the running local stack`.

**Trigger surface:** Running `pnpm test`, `pnpm test -- --id <flow>` or `--db-only` in a worktree that ran `pnpm test -- --browser-only` earlier, or after `git checkout` of another branch in the same worktree.

**Incident:** 2026-10-07, KRTX-1743. A browser-lane run ended with "Command failed with signal SIGTERM" and left its bun API running on the worktree port. For about an hour, later runs on three branches reused it. A new field on `GET /triggers` (`next_fire_at`) was missing from the response, and flow TRG-17 failed. After a manual `kill` of the process on the port, TRG-17 passed. The three branches changed no API code, so their attestations stayed valid. A branch with an API change would have attested its flows against the old API.

**Enforcement:** none yet. The runner should compare a source fingerprint of the running API with the checkout, and restart on a mismatch. The browser lane should stop the API it started. Tracked as a follow-up task from this session.
