---
recorded: 2026-10-05T14:42:44Z
incident_date: 2026-10-05
---
# Never let a config release the API cannot build replace a session's running config

**Rule:** A descriptor with `release_id: null` and a reason means "no release".
The daemon keeps its running config. The API assigns the project's last proven
release and states why in `fallback_reason`. Never derive a release ID from a
failed build, and never report a step-down with `fallback_reason: null`.

**Trigger surface:** editing `apps/api/src/config-releases/builder.ts` or
`desired.ts`, `effectiveReleaseId` in the daemon's
`services/config-release/release.ts`, or any path that returns a release
without an archive.

**Incident:** 2026-10-05, found while testing `config_releases` on a local
stack with real Platinum boxes. One 5.5 MB file under `skills/` pushed the
composed archive over the 4 MiB cap. The builder answered `release_id: null`,
`config_tree_id: null` plus governance. The daemon derived a governance-only ID
and swapped every running session of the project, OpenCode and pi, to the
image default: 25 → 14 tools, 22 → 1 skill, no plugin. Health said `proven:
true, fallback_reason: null`. `GET /config` said `stale: true` forever,
"Reload config" answered "already current", and each prompt paid ~2.2 s of
convergence. The same silence hid a project quarantine: new sessions ran an
older commit and the API reported `stale: false`, no reason.

**Enforcement:** `quarantine.test.ts` ("an unbuildable tip assigns the last
proven release and says why"), `config-release-boot.test.ts` ("a descriptor
with no release keeps the last proven copy and states the API reason"),
`config-release-converge.test.ts` ("no release and no tree").
