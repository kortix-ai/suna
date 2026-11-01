Compaction summaries show once, and steadier deploys

Compaction summaries show once, and steadier deploys

### Fixed
- After an automatic compaction, the summary shows once, inside the "Context automatically compacted" marker, instead of a second time below it (#11417).

### Improved
- A worker service that scales up from zero waits for its previous deployment to leave before it rolls, so deploys no longer collide (#11413).
- The macOS desktop installer builds on macOS 15 runners, so a release no longer loses it during GitHub's macOS 14 retirement (#11412).
