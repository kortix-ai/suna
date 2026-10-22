---
recorded: 2026-09-28T12:39:10Z
incident_date: 2026-09-25
---
# Check which credential types a provider endpoint accepts, not only its path

**Rule:** Before calling a provider endpoint, check which credential types it accepts, not only its path and permissions. GitHub publishes one list for App installation tokens and one for user access tokens: `POST /orgs/{org}/repos` is on the first, `POST /user/repos` only on the second. A client detector matches a code or a message, never a bare status: every 502 reaches the browser as a 503. A provider 404 on `/access_tokens` is authority to delete that connection row.

**Trigger surface:** any new provider call or change to which token a call carries; `projects/github.ts` `createRepo`; `upsertAccountGitHubInstallation`; any web check on `status === 503`.

**Incident:** every "Create a new repository" under a personal GitHub account failed with `403 Resource not accessible by integration`, shown as "Managed git isn't set up on this server" because the edge rewrote the 502 to 503 and `isManagedGitUnavailableError` matched any 503. `unit-github-owner-type-routing.test.ts` asserted the `/user/repos` routing against a stub that always returned 201. Separately, a reconnect minted a new installation id, the old row survived (upsert conflicted on `(account_id, installation_id)` only), the list ordered oldest-first, and `/new` defaulted to the dead row: "no longer valid, reconnect" right after reconnecting. PR #7445.

**Enforcement:** `installation-healing.test.ts`; `integration-github-installation-dedupe.test.ts` (real PostgreSQL, unique index answers 23505); `github.test.ts` "createRepo under a personal owner"; `project-from-repository-personal-account.test.ts`; `apps/web/.../github-user-authorization.test.ts`.
