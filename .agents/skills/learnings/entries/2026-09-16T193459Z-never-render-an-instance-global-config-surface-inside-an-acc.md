---
recorded: 2026-09-16T19:34:59Z
commit: df7eda321b
---
# Never render an instance-global config surface inside an account-scoped page

**Incident (2026-09-16, prod, ~6 min):** the `Managed GitHub` card sits on
`Settings → <any account> → Git`, directly under the account-scoped
`GitHub connections` card. It edits ONE global row,
`kortix.platform_settings.managed_github_app`. A platform admin ran its
manifest flow while looking at one customer account's settings. GitHub created
App `kortix-self-host-05804762` (appId `4968692`) and the callback wrote that
row at `17:52:48Z`.

Every managed-git accessor reads DB-first, env-fallback
(`apps/api/src/projects/git-backends/github.ts:28-72`,
`apps/api/src/projects/github.ts:135-192`). One row therefore shadowed the whole
production GitHub identity at once: appId `3812697` → `4968692`, slug
`kortix-private-repo-access` → `kortix-self-host-05804762`, managed owner
`managed-kortix` → `kortix-ai`, plus clientId, clientSecret and stateSecret.

Blast radius: all 39 accounts in `kortix.account_github_installations` 404ed on
`/app/installations/<id>/access_tokens`, because their installations belong to
App `3812697`. Managed repo creation failed too — owner resolved to `kortix-ai`
while the auth token stayed the env PAT (`GET /orgs/kortix-ai` → 403,
`GET /orgs/managed-kortix` → 200). Recovery: `update kortix.platform_settings
set value='{}' where key='managed_github_app'`, which restores the env fallback
within the 30s config cache TTL.

**Rule:** a surface that writes instance-global state never renders inside a
page scoped to one account. Put it on an explicit platform/admin route. When a
global write would shadow working env configuration, the UI must name the
current effective value, name what will replace it, and require typed
confirmation. DB-first/env-fallback resolution must refuse to go partial: a
stored owner must not combine with an env token from a different owner.

**Enforcement (branch `git-connection-path`):** the config is resolved whole
from one source by `resolveAppIdentity()` and `resolveGitBackend()`
(`apps/api/src/platform/services/{github-app-identity,managed-git-backend}.ts`);
`instance-git-config.test.ts` rejects a mixed DB-owner/env-token row. Every
`/v1/platform/github-app/*` mutation answers `409 instance_identity_is_env_managed`
when env owns a half (`github-app-instance-gate.test.ts`; flow `GHA-1` asserts
it live against `GET /status.mutable`). The card renders only at `/admin/git`
(journey `09`); the account Git tab never calls the platform status route and
never renders "Managed GitHub" (journey `30`). The instance backend has its own
namespace, `GET /v1/projects/git/backend[/repositories]`, and is no longer a
synthetic entry in the account connection list (flow `GH-18`).
