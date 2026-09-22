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

## Kortix cloud runs managed git on the App only

The instance git backend has two forms: a GitHub App installation
(`MANAGED_GIT_GITHUB_OWNER` + `MANAGED_GIT_GITHUB_INSTALL_ID`) or a token
(`MANAGED_GIT_GITHUB_TOKEN`). The token form stays a supported self-host option.
Kortix cloud uses the App: one credential model, and every git write gets a
short-lived token scoped to one repository instead of a long-lived
organization-wide token.

**When both are set, the token wins and the App is never consulted.**
Production ran that way from 2026-08-30. Its token could not create a
repository, so every project creation failed while an App that could create
one sat unused. The API now logs this once per process:
`[managed-git-backend] MANAGED_GIT_GITHUB_TOKEN and MANAGED_GIT_GITHUB_INSTALL_ID are both set: ...`.

To select the App on a deployed environment:

1. Confirm the environment's App is installed on the managed organization with
   `administration: write` and `contents: write`, and that
   `MANAGED_GIT_GITHUB_INSTALL_ID` is an installation of THAT App. A stale id
   answers `404` on token mint. Verified values, 2026-09-21: prod `140097279`,
   dev `158197129`, staging `158197210`.
2. Set `MANAGED_GIT_GITHUB_TOKEN` to an **empty value** in the
   `kortix-<env>-env` Secrets Manager blob, and merge into the current JSON:
   never write a fresh key set. The resolver treats an empty value as unset. The
   blob's primary region is `us-west-2`; `eu-west-2` is a read replica, so read
   `describe-secret --query PrimaryRegion` before writing. (The 2026-07-18
   outage came from a task definition that referenced this key by name. Current
   task definitions read the whole blob through one `KORTIX_ENV_JSON` selector,
   so a missing optional key no longer blocks task start. Emptying stays the
   reversible choice.)
3. Set a read-only `GITHUB_TOKEN` if none exists. The marketplace catalog reads
   `GITHUB_TOKEN || MANAGED_GIT_GITHUB_TOKEN`; without either it falls back to
   unauthenticated GitHub at 60 requests per hour.
4. Restart the API tasks (`aws ecs update-service --force-new-deployment`). The
   blob is read at task start.
5. Make the tracked file match: an empty blob value means the key is ABSENT
   from `apps/api/.env.<env>` (`secrets-sm-parity.py`, "an empty SM value is
   satisfied by absence"). Set any new key with `dotenvx set`. Run
   `python3 scripts/secrets-sm-parity.py check <env>`; use `pull` only after
   reading the diff, because it copies every differing value from the blob.
6. Prove it: `GET /v1/projects/git/backend` reports `"kind":"app"`, then create
   a real project.

**Production switched to the App on 2026-09-21 10:47Z** (secret version
`95916fdd…`, previous `71c9941b…`). Proof on `https://api.kortix.com`: backend
`"kind":"app"`, provision `201`, clone and push through the git proxy, purge
`repo_deleted:true`, and zero `provision create_repo failed` lines after the
restart. **Dev and staging switched on 2026-09-21 11:06Z** (dev
`63e1e941…`, staging `64e79c44…`), with their installation ids corrected. Each
passed backend `"kind":"app"`, provision `201`, clone, push, and purge on its own
API. All three environments now run managed git on the App only, and
`secrets-sm-parity.py check dev staging prod` is clean. No Kortix-cloud
environment holds a managed-git token.

Verified on the App path locally, real API against real GitHub (2026-09-21): provision
`201` with starter commits, read, rename, clone and push through the git proxy,
archive, and purge (`repo_deleted: true`, GitHub `404` afterwards).

**Alerting.** Better Stack turns every `[projects] provision create_repo failed`
line from the prod API into the metric `provision_create_repo_failed` (log-to-
metric rule `m-25907071` on source `kortix_api`, 2346957). The dashboard
"Kortix API — project creation" (1131427) charts it, and the alert
"Prod: managed project creation failing" (2988583914) opens an incident at 3 or
more failures in 10 minutes, by email and push. The log line covers both
creation routes; `POST /v1/projects/provision-stream` answers `200` with an
`error` frame, so a status-code alert alone misses half the failures. The
outage produced about 12 failures per 10 minutes.

**Known gap: collaborator invitations.**
`POST /v1/projects/:id/git/collaborators` answers `200` on the App path for an
organization member. Inviting a non-member is unverified: the App got `403
Resource not accessible by integration` for a username where an organization
owner token got `404`. The git proxy covers the need without it: any holder of a
Kortix token clones and pushes `/v1/git/<projectId>.git`.

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
