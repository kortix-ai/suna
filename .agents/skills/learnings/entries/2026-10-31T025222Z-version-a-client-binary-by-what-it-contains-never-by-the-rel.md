---
recorded: 2026-10-31T02:52:22Z
incident_date: 2026-10-31
---
# Version a client binary by what it contains, never by the release it ships in

**Rule:** A release publishes a new installed-client version (the desktop app's
`latest*.yml`) only when the client's own inputs changed. Derive the decision
from a fingerprint of those inputs: the client sources, their dependency
closure, the build job. Never stamp the release version onto an unchanged build.
An unchanged release copies the previous installers byte for byte.

**Trigger surface:** Changing `build-desktop` or `attach-desktop` in
`.github/workflows/deploy-prod.yml`, `apps/desktop-electron/scripts/release-fingerprint.mjs`,
or adding another client that self-updates from the `vX.Y.Z` releases.

**Incident:** Until 2026-10-31 every prod release rebuilt the desktop app with
the release version. Every desktop user got "Kortix X.Y.Z is ready to install"
and a restart prompt for each release, also when nothing in the app changed.
v0.14.0 to v0.14.12: 6 of the 12 releases shipped an app with no desktop change.
Each update also replaced Kortix.app under a running computer agent, the trigger
of the 2026-10-09 TCC entry.

**Enforcement:** `tests/unit/desktop-release-fingerprint.test.ts` (the
closure follows transitive dependencies and refuses an unresolvable lockfile;
`build-desktop` runs only when `desktop-plan` asks; `attach-desktop` records
`DESKTOP-FINGERPRINT`).
