Idle-stopped sessions come back on their own

### Fixed
- Opening a session whose sandbox had gone idle no longer dead-ends on "OpenCode failed to load / sandbox not ready." The runtime now wakes on its own when you open the session — the same recovery a manual refresh used to do — so idle sessions just come back.
- A session's status now flips to "running" in the sidebar as soon as it connects, instead of staying "stopped" until you refresh the page.
