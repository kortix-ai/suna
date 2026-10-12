---
recorded: 2026-10-07T12:06:23Z
incident_date: 2026-10-07
---
# Remove a disposable container with docker rm -f -v, never docker rm -f alone

**Rule:** A test that starts a disposable container removes it with `docker rm -f -v <name>`. `docker run --rm` cleans the anonymous volume only when the container exits on its own; a forced `docker rm -f` skips that cleanup and leaves the volume behind.

**Trigger surface:** Writing or editing a test that runs `docker run` (the disposable PostgreSQL pattern in `packages/db/scripts/*.integration.test.ts` and `tests/migration/*.test.ts`), and debugging local Postgres failures: "No space left on device", `checkpoint request failed` (XX000), or "Disposable PostgreSQL did not become ready".

**Incident:** 2026-10-07, local development. 41 cleanup calls in 29 test files used `docker rm -f` without `-v`, so each disposable PostgreSQL run left a ~65 MB anonymous volume. One full `pnpm test` runs about 40 of them (~2.6 GB). After a day of full runs, 997 orphaned volumes held 64.5 GB and filled the 87 GB Docker VM disk. Every local Postgres on the machine (the shared dev stack and every worktree stack) then failed writes, and two branches' full runs went red on unrelated suites. Recovery: remove only unattached anonymous volumes, `docker volume ls -qf dangling=true | grep -E '^[0-9a-f]{64}$' | xargs docker volume rm`; named volumes (other worktrees' Supabase data, caches) stay.

**Enforcement:** `tests/unit/docker-rm-removes-volumes.test.ts` (core lane) fails on any `'docker', 'rm', '-f'` without `'-v'` in a `.ts`, `.tsx` or `.mjs` file.
