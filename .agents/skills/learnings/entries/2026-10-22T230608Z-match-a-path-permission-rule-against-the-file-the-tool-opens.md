---
recorded: 2026-10-22T23:06:08Z
incident_date: 2026-10-19
---
# Match a path permission rule against the file the tool opens, never the string the model wrote

**Rule:** A permission rule for a file tool matches the file the tool will open: resolve the path argument exactly as the tool does (`./`, `..`, `@`, `~`, `file://`, absolute), then match it relative to the workspace. A path that leaves the workspace also answers to `external_directory`, and the strictest rule wins. A path that does not resolve fails closed.

**Trigger surface:** Writing or porting a harness permission check (`harness/pi/interactions.ts` `permissionSubject`, a new harness), adding a tool that takes a path, or bumping pi-coding-agent (its `utils/paths.ts` resolver is copied, not imported).

**Incident:** 2026-10-19, near-miss found in a pi parity review. pi matched the raw `path` string, so `./secrets/a`, `x/../secrets/a`, `@secrets/a` and `/workspace/secrets/a` all got past a `secrets/*` deny, and `external_directory` rules did nothing. OpenCode resolves first. It stayed open after pi became the prod default on 2026-10-21. Fixed in PR #10787.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/pi-permission-patterns.test.ts` (every path spelling, `external_directory` rows), `pi-harness.test.ts` "a path deny holds for every spelling…" (the real pi read tool), and flow `RUN-10` on a real box (reads `./private/notes.txt` under a `private/*` deny).
