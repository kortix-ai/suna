Idle sessions wake on their own, invitation fix, and quieter UI

### Fixed
- Opening an idle-stopped session now wakes it on its own instead of dead-ending on "OpenCode failed to load / sandbox not ready." When a real user hits a stopped-but-resumable box, the runtime resumes in place, and the session's status flips to running without a manual refresh.
- Invitation listing and acceptance no longer error — a database column the code relied on was missing and is now added.
- Sessions keep their sandbox identity through recovery and reprovision cleanly after a daemon boot error.
- Quieter, more reliable UI: the transient "runtime still starting" state is no longer reported as an error, and a couple of edge-case crashes (malformed links, a non-string command template) are guarded.

### New
- Executor connection profiles — group a connector's credentials under a named profile.
