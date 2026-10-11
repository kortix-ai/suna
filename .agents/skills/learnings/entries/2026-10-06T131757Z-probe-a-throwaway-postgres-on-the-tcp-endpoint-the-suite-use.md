---
recorded: 2026-10-06T13:17:57Z
incident_date: 2026-10-04
---
# Probe a throwaway Postgres on the TCP endpoint the suite uses, never the in-container Unix socket

**Rule:** A suite that boots a throwaway Postgres container must gate readiness on the endpoint it will actually use — `psql <host-url> -tAc 'select 1'` from the host, or `pg_isready -h 127.0.0.1` inside the container. Never `docker exec pg_isready` with no `-h`: that probes the container's Unix socket.

**Trigger surface:** Any `tests/migration/*.test.ts` or `*.integration.test.ts` that `docker run`s `postgres` and then runs `runMigrate`/`psql` against a published port (`-p 127.0.0.1:<port>:5432`).

**Incident:** 2026-10-04 and 2026-10-06, the `db-suites` attestation lane. The postgres entrypoint's temporary init server starts with `listen_addresses=''`, so the socket-only server answers `pg_isready` while nothing serves TCP yet; `docker run -p` has already published the port, so the proxy accepts and closes the suite's first connection. The suite then read `server closed the connection unexpectedly` / `migrations failed` seconds into a container it had been told was ready — a false red that flapped (the same file passed one run and failed the next). Five booting suites probed the socket across three runs before every probe read TCP; the racing loop hit five suites in the same files. A second defect in the same loop made it worse: re-polling once after the loop broke let a failed probe right after a successful one throw anyway — the last poll inside the loop must be the proof. Full timeline: `tests/migration/worktree-migrate.test.ts` (CI run 36153691220).

**Enforcement:** The suites' own readiness loops — every booting migration suite now probes the host TCP endpoint and lets the loop's last poll prove readiness (`tests/migration/worktree-migrate.test.ts` carries the canonical comment). The `db-suites` lane runs all of them on every `pnpm test`; a socket probe reintroduced anywhere in `tests/migration` flaps the lane red. No static gate yet: grep `pg_isready` under `tests/` and require an explicit `-h` host when adding a new booting suite.
