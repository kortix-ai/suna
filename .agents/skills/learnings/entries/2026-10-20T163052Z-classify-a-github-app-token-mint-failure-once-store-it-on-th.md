---
recorded: 2026-10-20T16:30:52Z
incident_date: 2026-10-20
commit: 0118345767
---
# Classify a GitHub App token-mint failure once, store it on the git connection, and answer one typed error everywhere

**Rule:** A failed `POST /app/installations/<id>/access_tokens` is classified once, in `resolveProjectGitAuth`, by `classifyInstallationTokenError` (`apps/api/src/shared/repository-health.ts`): 404 → `app_uninstalled`, 403 "suspended" → `app_suspended`, 422 → `repo_not_accessible`, 5xx/429/network → retryable, nothing stored. A disconnect is stored on `project_git_connections` (`status = 'error'`, `last_error_code = <reason>`) and thrown as `RepositoryDisconnectedError` from `resolveProjectUpstream`; `http-errors.ts` answers 409 `repository_disconnected`. Never hand a caller a credential-less upstream for a disconnected repository: GitHub answers it `Repository not found`, and the mirror retries that as transient. Log the state change once, not each request. While disconnected, probe GitHub at most once per `PROBE_INTERVAL_MS`.

**Trigger surface:** Any change to git auth resolution, the git proxy, the mirror, session create or start, the trigger scheduler, or a route that reads the repository. Any new GitHub App error path.

**Incident:** 2026-10-20. A customer GitHub org uninstalled the Kortix GitHub App. Both projects in that workspace and their scheduled syncs broke. Each surface showed a different wrong cause: sessions "machine could not be reached" and "agent not declared", project detail `unknown_reason: unreadable`, the git proxy `Repository not found`, and a warning per request in the API log (KRTX-2952..2955). Fixed in #10544. Near-miss during the proof: a per-minute cron trigger on the shared local database was fired by another stack's scheduler, which runs code without the fix, and booted a real sandbox. Prove scheduler behavior in a DB suite (its own database) or with a far-future cron, never with a short cron on the shared local database.

**Enforcement:** `apps/api/src/shared/repository-health.test.ts` (classifier, probe interval), `apps/api/src/__tests__/integration-repository-disconnected.test.ts` (store, back-off, outage stores nothing, reconnect clears and repoints, scheduled run skipped), `apps/api/src/git-proxy/upstream-credential.test.ts` (409 text/plain, upstream never hit), `packages/sdk/src/core/http/repository-disconnected.test.ts`, `packages/ui/src/workspace/repository-disconnected.test.tsx`, `apps/cli/src/__tests__/repository-disconnected.test.ts`. None yet for GitHub `installation` webhooks: the App manifest registers webhooks inactive, so recovery is the probe plus the reconnect flow.
