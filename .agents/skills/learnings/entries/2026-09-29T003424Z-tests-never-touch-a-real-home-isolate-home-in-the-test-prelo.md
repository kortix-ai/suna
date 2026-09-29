---
recorded: 2026-09-29T00:34:24Z
incident_date: 2026-09-28
---
# Tests never touch a real home: isolate HOME in the test preload, and gate host-path fallbacks to the sandbox

**Rule:** A test process runs with `HOME` pointing at a fresh temp dir (package test preload), and any product code path that writes under `$HOME` for the sandbox (e.g. the runtime-assets CLI fallback `$HOME/.local/bin/kortix`) runs only where it is meant to (Linux sandbox), never on a developer machine.

**Trigger surface:** Writing daemon or CLI code that installs, updates or writes files relative to `$HOME`, or tests that drive such code (kortixd runtime-assets, CLI self-update).

**Incident:** 2026-09-28 ~00:21Z. A local kortixd test run (agents running the packages lane on a developer Mac) overwrote the developer's real `~/.local/bin/kortix` with the fixture text `NEW-CLI-BYTES` through the runtime-assets writable-PATH fallback. The CLI stopped working (`NEW-CLI-BYTES: command not found`) until it was reinstalled from the v0.13.40 release.

**Enforcement:** `apps/kortix-sandbox-agent-server/bunfig.toml` preloads `src/__tests__/preload-isolated-home.ts` (HOME → temp dir) for every kortixd test; `runtime-assets.ts` uses the `$HOME` fallback only when `process.platform === 'linux'`. Verified: full kortixd suite 1644 pass with the developer CLI byte-identical before and after.
