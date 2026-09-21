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

## Required App permissions

`REQUIRED_GITHUB_APP_PERMISSIONS` (`apps/api/src/projects/github.ts`) is the one
list. An App created by hand must hold it. The self-host manifest requests this
set plus `pull_requests: write`, which is reserved: no flow uses it today, and
no GitHub token reaches a sandbox.

| Permission | Level | Flow that needs it |
|---|---|---|
| `metadata` | read | every App call |
| `contents` | write | commits and pushes |
| `administration` | write | `createRepo` under a connected organization |
| `members` (organization) | read | `verifyGitHubInstallationAdmin`, `listLinkableGitHubAppInstallations` |

Without `members: read`, GitHub answers `403` on both membership reads. A
personal (`User`) installation still links. Every organization installation
fails verification, including for an organization owner.

Check any App without credentials:

```bash
gh api /apps/<slug> --jq .permissions
```

The API logs the drift once per process on the first `GET /app`:
`[github-app] App "<slug>" is missing required permissions: ...`. The link
routes answer with `GitHubAppPermissionError`: status `502` (`503` on the wire)
when the App lacks the permission, `403` when only one installation lacks it.

Adding a permission to an App does not change existing installations. Each
installed organization must accept the request in its GitHub App settings, or
reinstall.

## Organizations with an IP allow list

A GitHub Enterprise Cloud organization can refuse every request from an
address outside its allow list, including requests made with a Kortix App
installation token. Every Kortix request to GitHub leaves from the API: API
calls and the git proxy (`/v1/git/<projectId>.git`). No sandbox talks to GitHub
with a host credential. The addresses to allow are the API's NAT gateway
Elastic IPs (`infra/terraform/modules/network/main.tf`, `aws_eip.nat`):

```bash
aws ec2 describe-nat-gateways --region eu-west-2 \
  --query 'NatGateways[].NatGatewayAddresses[0].PublicIp' --output text
```

1. **Kortix, once per App:** publish those addresses on the App — App settings →
   General → IP allow list. Repeat for the shadow region when it serves traffic.
2. **The organization owner:** organization Settings → Authentication security →
   enable **IP allow list configuration for installed GitHub Apps**. GitHub then
   imports the App's addresses as "Managed by the <App> GitHub App" and keeps
   them in sync.

GitHub documents that an App's addresses cover requests made by the App's
installations. The account-linking proof uses an App *user* token
(`verifyGitHubInstallationAdmin`). If GitHub refuses that read, the link route
answers `GitHubIpAllowListError` (`403`) naming the organization. Fallback: the
owner adds the same addresses to the organization list by hand.

A NAT gateway replacement changes the address. Update the App list in the same
change.

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
