---
recorded: 2026-09-28T08:17:14Z
incident_date: 2026-09-25
supersedes: 2026-09-25T081543Z-a-model-check-that-says-usable-must-use-the-scope-the-gatewa.md
---
# Recheck a session's model when a share narrows its key scope

**Rule:** A visibility change is a key-scope change. Before a write stores a visibility that takes a session's personal keys away, resolve the scope against the pending visibility (`resolveSessionPersonalOwner({ visibility })`) and check that the session's model still runs. If it does not, select the keys shared with the whole project (`admitSessionSharingChange`), or refuse the write. The rule of the superseded entry still holds for every other check.

**Trigger surface:** changing who can open a session, its owner, or its `on_behalf_of`; adding any route that writes `project_sessions.visibility`.

**Incident:** dev, 2026-09-25. A private session selected a ChatGPT connection granted only to its owner, and `PUT /sessions/:id/sharing` shared it with `200`. The shared session then answered `400 INVALID_SESSION_MODEL` to its own model, and every turn would have failed with "Connect Codex". PR #7657. Still open: the first prompt from another human (an admin under session oversight) clears `on_behalf_of` for good and narrows the scope the same way, with no check.

**Enforcement:** `unit-session-model-keys.test.ts` (`admitSessionSharingChange`: switch, replace, refuse, no-scope-change cases), flow `SEC-POOL-2` (`409 SHARED_SESSION_NEEDS_PROJECT_KEY`, then the switch to the project's key), plus the enforcers of the superseded entry.
