# Instance GitHub configuration — identity, git backend, account connection

Three concepts. They are never conflated, never merged into one row, and never
resolved field by field.

| Concept | What it is | Where it lives | Scope |
| --- | --- | --- | --- |
| **App identity** | `appId`, `privateKey`, `clientId`, `clientSecret`, `webhookSecret`, `stateSecret`, `slug` | env `KORTIX_GITHUB_APP_*` / `GITHUB_APP_*`, or `kortix.platform_settings.github_app_identity` | deployment |
| **Instance git backend** | `{kind:'app', owner, ownerType, installationId}` or `{kind:'pat', owner, token}` | env `MANAGED_GIT_GITHUB_OWNER` + (`MANAGED_GIT_GITHUB_TOKEN` or `MANAGED_GIT_GITHUB_INSTALL_ID`), or `kortix.platform_settings.managed_git_backend` | deployment |
| **Account connection** | one account's own GitHub App installations | `kortix.account_github_installations` | one account |

## Resolution rules

- **Whole config, one source.** `resolveAppIdentity()`
  (`apps/api/src/platform/services/github-app-identity.ts`) returns an identity
  from env when env carries BOTH an appId and a private key; otherwise from a
  COMPLETE stored row; otherwise null. `resolveGitBackend()`
  (`apps/api/src/platform/services/managed-git-backend.ts`) applies the same
  all-or-nothing rule per source, and a stored owner is never paired with an
  env token.
- **A partial env backend refuses.** If any of the three `MANAGED_GIT_*`
  variables is set, env owns the backend. An incomplete env set resolves to
  null with one logged reason; the database never completes it.
- **The slug is derived, not configured.** `resolveGitHubAppSlug()`
  (`apps/api/src/projects/github.ts`) reads `GET /app` with the identity's own
  JWT, caches per appId for 1h, and only falls back to a configured slug when
  that read fails. A mismatch logs one warning.
- **Env-managed instances are immutable from the UI.** Every mutation route
  under `/v1/platform/github-app/*` answers
  `409 {"error":"instance_identity_is_env_managed", …}` when either half is
  env-owned.

## Reading the live configuration

```bash
# Which source owns what, and may the UI change it?
curl -sS -H "Authorization: Bearer $JWT" \
  https://dev-api.kortix.com/v1/platform/github-app/status | jq

# The instance backend, as any authenticated user sees it
curl -sS -H "Authorization: Bearer $JWT" \
  https://dev-api.kortix.com/v1/projects/git/backend | jq
```

## The pending contract migration

`20260916184801110_split_managed_github_app_into_identity_and_backend.sql`
copies the legacy `managed_github_app` row into the two new keys and leaves the
legacy row in place. The application code already reads only the new keys.

Deleting the legacy key belongs in the release AFTER the one that carries that
expand migration, because migrations apply before the new image rolls: a delete
in the same release strips the stored configuration from every old pod for the
length of the rollout.

Create it then, with this body:

```sql
-- Contract half of 20260916184801110. Ships no earlier than one release after
-- that file, and only once the release carrying it is live everywhere.
-- mixed-version-safe: no code reads `managed_github_app`; the readers were
-- deleted in the release that shipped the expand migration.
-- backfill-safe: kortix.platform_settings, exactly one row, deleted by primary key.
set lock_timeout = '2s';
set statement_timeout = '30s';

delete from kortix.platform_settings where key = 'managed_github_app';
```

Verify before and after:

```bash
psql "$DATABASE_URL" -c \
  "select key from kortix.platform_settings where key in
     ('managed_github_app','github_app_identity','managed_git_backend');"
```

## Recovery

A stored row that shadows a working env configuration is no longer possible on
an env-managed deployment — the routes refuse the write. If a stored row is
wrong on a self-host instance, clear it:

```sql
delete from kortix.platform_settings
 where key in ('github_app_identity', 'managed_git_backend');
```

The resolvers fall back to env within the 30s cache TTL.
