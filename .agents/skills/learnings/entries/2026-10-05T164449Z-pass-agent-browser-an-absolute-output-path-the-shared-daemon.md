---
recorded: 2026-10-05T16:44:49Z
incident_date: 2026-10-05
---
# Pass agent-browser an absolute output path: the shared daemon resolves a relative path against another worktree

**Rule:** Give `agent-browser record start`, `screenshot` and every other output path as an absolute path (`$PWD/output/pr/demo.mp4`). The daemon is shared by every session on the machine and resolves a relative path against the cwd of the session that started it.

**Trigger surface:** recording a PR demo or taking screenshots with agent-browser while another worktree's session also uses it.

**Incident:** 2026-10-05, agent-browser 0.27.0. A session on one worktree ran `record start output/pr/demo.mp4`. The file landed in another worktree's `output/pr/demo.mp4`, the path that worktree's PR body attaches with `gh --attach`, and replaced whatever was there. Caught before upload: the file was moved back out and the owning sessions were told.

**Enforcement:** none yet. The contributing skill recipe now uses `OUT="$PWD/output/pr"`. Enforcer to build: `preview-sign-in.sh` (or a demo wrapper) that refuses a relative output path.
