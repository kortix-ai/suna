---
recorded: 2026-10-03T23:39:11Z
incident_date: 2026-10-03
---
# Never let a test reach the box's real ~/.local/bin/kortix: the writable-PATH fallback is the first PATH hit, so a fixture write there shadows the installed CLI

**Rule:** A test process must never hold the box's real `HOME` while code that can write `~/.local/bin/kortix` runs: `cliPathFallback()` is FIRST on the session's `KORTIX_PATH`, so whatever lands there shadows `/usr/local/bin/kortix` for every later `kortix` invocation — including the agent's own CLI. If a test needs the fallback, it points `HOME` at a temp dir it owns.

**Trigger surface:** Running the daemon/runtime-assets suites (or anything that drives `runtime-assets.ts` `replaceCli`'s writable-PATH fallback) outside the suite's own HOME preload — spawned children, another workspace's runner, a bare `bun test` from the wrong directory.

**Incident:** 2026-10-03 ~18:37Z, factory worker sandbox, v0.13.48-staging. A 13-byte fixture (`NEW-CLI-BYTES`) appeared at the real `$HOME/.local/bin/kortix` during a standalone daemon-suite run; `which kortix` then resolved the fixture first and every `kortix` CLI call died with `NEW-CLI-BYTES: command not found`. `/usr/local/bin/kortix` itself was untouched. Restored by deleting the shadow file. The writer process is not yet identified: the `preload-isolated-home.ts` preload (supersedes nothing, extends `2026-09-29T003424Z-tests-never-touch-a-real-home…`) covers the test process itself, so the write came from a path the preload does not reach.

**Enforcement:** none yet: build a tripwire that fails when a test process's `HOME` resolves to a real user home while `runtime-assets.ts` is loaded — e.g. extend `preload-isolated-home.ts` to also re-point `HOME` inside spawned children (export the temp home through the env the runner already controls), plus a post-suite check that `$HOME/.local/bin/kortix` is absent or matches the installed binary's digest.
