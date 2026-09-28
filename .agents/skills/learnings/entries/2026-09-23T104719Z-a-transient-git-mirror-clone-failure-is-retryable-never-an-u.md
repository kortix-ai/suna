---
recorded: 2026-09-23T10:47:19Z
incident_date: 2026-09-23
commit: 954e8614ce
---
# A transient git-mirror clone failure is retryable, never an unhandled 500

**Rule:** Classify a bare clone/fetch failure by CAUSE, not by exit kind. Both a
mid-clone timeout AND a transient upstream failure — network/DNS/socket, GitHub
5xx, or GitHub's ambiguous `fatal: repository '<url>' not found` for a PRIVATE
mirror whose App installation token is momentarily unusable — are retryable:
retry the clone a bounded number of times, and answer a retryable 503 +
`Retry-After` without paging Sentry. Only a PERMANENT failure (bad ref, real
auth denial, corrupt local repo) may answer 500. **Incident:** the hourly
heartbeat probe's `sessions new` cold-cloned a private mirror, got `fatal:
repository '<url>' not found`, and hard-failed with HTTP 500 (KX-HOURLY FAIL,
2026-09-23T10:06Z) — while the git proxy served the same repository 200 seconds
before and after. **Enforcers:** `isTransientGitMirrorError` and
`cloneBareWithRetry` in `apps/api/src/projects/git/mirror.ts`;
`mirror-transient.test.ts`, `unit-git-mirror-transient-onerror.test.ts`.
