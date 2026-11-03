---
recorded: 2026-11-03T07:34:17Z
incident_date: 2026-11-03
---
# Refresh apt indexes before installing Git bootstrap prerequisites

**Rule:** Refresh apt indexes before installing a missing Git bootstrap prerequisite.

**Trigger surface:** The contract workflow installs software-properties-common on a runner without add-apt-repository.

**Incident:** Release v0.14.17, run 41590536896 attempt 3, stopped all six contract lanes before tests. The prerequisite install ran against empty package indexes and returned exit 100.

**Enforcement:** The release contract lanes fail closed when Git setup fails. Reproduce locally with an empty apt lists directory, then refresh that directory and repeat the download-only install.
