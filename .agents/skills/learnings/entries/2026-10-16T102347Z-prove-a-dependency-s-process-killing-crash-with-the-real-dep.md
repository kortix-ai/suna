---
recorded: 2026-10-16T10:23:47Z
incident_date: 2026-10-16
---
# Prove a dependency's process-killing crash with the real dependency over a real socket, then patch it via pnpm patch with the upstream guard and a red-to-green regression test

**Rule:** When prod dies inside a dependency (uncaughtException whose stack lands in `node_modules`), do not stop at "it's upstream's bug". First reproduce the crash with the **real dependency** — over a real TCP socket with real event ordering, never a mock of the module under test — and watch it fail. Then, if upstream has no released fix, apply the smallest approved upstream guard as a `pnpm patch` (wire it through `pnpm.patchedDependencies` so a fresh `pnpm install --frozen-lockfile` applies it), and ship the red→green regression test in the same PR. State the patch's known limitations (what still misbehaves upstream) instead of silently widening the fix.

**Trigger surface:** Any fix for a crash whose stack points into a vendored dependency (`node_modules/...` in the Sentry/better stack frame), and any `patches/*.patch` addition.

**Incident:** 2026-10-16, KRTX-2511. The prod API process (Bun) died once at 06:10:57 UTC with an uncaught `TypeError: null is not an object (evaluating 'socket.write')` from postgres.js 3.4.9 `nextWrite` (`src/connection.js:255`) after the server closed the connection mid-write and the pool handed the dead connection back out. Upstream knew the bug (porsager/postgres #1066/#1154/#1208) with approved but unmerged guard PRs (#1168/#1176). Fixed by `patches/postgres@3.4.9.patch` plus a regression test that drives postgres.js against an in-process fake PostgreSQL server through the exact crash sequence.

**Enforcement:** `packages/db/src/postgres-write-guard.test.ts` — on unpatched 3.4.9 it fails with the production TypeError at `nextWrite` (`connection.js:255:15`); with the patch it passes. It runs in every `pnpm test` (packages lane), so removing the guard or upgrading past a broken postgres release goes red.
