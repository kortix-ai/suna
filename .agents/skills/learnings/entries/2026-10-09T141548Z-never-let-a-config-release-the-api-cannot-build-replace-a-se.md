---
recorded: 2026-10-09T14:15:48Z
incident_date: 2026-10-05
supersedes: 2026-10-05T144244Z-never-let-a-config-release-the-api-cannot-build-replace-a-se.md
---
# Never let a config release the API cannot build replace a session's running config

**Rule:** A descriptor with `release_id: null` and a reason means "no release". The daemon keeps its running config. The API assigns the project's last proven release and states why in `fallback_reason`. Never derive a release ID from a failed build, and never report a step-down with `fallback_reason: null`. The rule is unchanged; the daemon service it names was renamed.

**Trigger surface:** Editing `apps/api/src/config-releases/builder.ts` or `desired.ts`, `effectiveReleaseId` in the daemon's `services/config-provider/release.ts` (named `services/config-release/` until 2026-10-09), or any path that returns a release without an archive.

**Incident:** 2026-10-05, on a local stack with real Platinum boxes: one 5.5 MB file under `skills/` pushed the composed archive over the cap, the builder answered `release_id: null`, and the daemon swapped every running session of the project to the image default while health said `proven: true, fallback_reason: null`. Full account in the superseded entry.

**Enforcement:** `quarantine.test.ts` ("an unbuildable tip assigns the last proven release and says why"), `config-release-boot.test.ts` ("a descriptor with no release keeps the last proven copy and states the API reason"), `config-release-converge.test.ts` ("no release and no tree").
