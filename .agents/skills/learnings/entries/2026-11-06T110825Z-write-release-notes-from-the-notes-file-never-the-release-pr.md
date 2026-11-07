---
recorded: 2026-11-06T11:08:25Z
incident_date: 2026-11-06
---
# Write release notes from the notes file, never the release PR body, and read RELEASE_NOTES.md on the release branch before merging

**Rule:** Pass `promote.yml` the release notes themselves (title and the New / Improved / Fixed bullets), never the release PR body. Before you merge a release PR, read `RELEASE_NOTES.md` on its `release/vX.Y.Z` branch: `deploy-prod.yml` publishes that file, not the PR body, as the GitHub Release and `/changelog`.

**Trigger surface:** Dispatching `promote.yml` (especially a re-promote with `ref=staging`), or an agent that copies notes from the open release PR.

**Incident:** 2026-11-06, v0.15.0 (#11872). A second release driver re-promoted and passed the PR body as `notes`. `RELEASE_NOTES.md` then held a duplicated title line, the "Merging this PR publishes" footer and a bot footer with tracking links. The release driver found it before the merge and re-promoted with the real notes, about 7 min of gate time lost. Nothing was published.

**Enforcement:** `promote.yml` refuses `notes` that contain the PR footer or bot markup (`Merging this PR **publishes`, `<!-- codesmith`, `blacksmith.sh`).
