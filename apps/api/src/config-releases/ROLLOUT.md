# Config releases: prod rollout

Config releases make a session run the base branch's **current, built**
config, from a read-only release directory — never the session's own
`/workspace` checkout. A release is the OpenCode config dir, the root
`skills/`, and the pi config dir as `pi/` (`builder.ts`, `composeReleaseTree`).
Both session runtimes apply them: OpenCode swaps in a proven replacement
process, pi reloads the release in place. Full contract:
`apps/api/src/config-releases/`,
`apps/kortix-sandbox-agent-server/src/services/config-release/`,
`apps/kortix-sandbox-agent-server/src/harness/open-code/config-release.ts`,
`apps/kortix-sandbox-agent-server/src/harness/pi/config-release.ts`.

## The lever

One gate: the per-project `config_releases` flag.

| Lever | Scope | Set by | Changed by |
|---|---|---|---|
| `config_releases` project flag | One project | Project owner/admin, at any time | Settings → Feature flags, or `PATCH /v1/projects/:projectId/features {feature:"config_releases",enabled:true|false|null}` |

The flag is available on every deployment, so the Settings row always
renders. It defaults to **off** (`apps/api/src/feature-flags/registry.ts`,
`platformDefault: () => false`). A project that made no choice reads its
workspace config directory directly — the pre-release behavior. There is no
operator env switch: `CONFIG_RELEASES_ENABLED` was removed.

## Rollout order

**Sandbox flows on deployed staging.** CFG-11 and CFG-12 are the only
config-releases flows that `requires: funded, daytona` — the only ones that
boot a real sandbox and prove the daemon side (descriptor fetch, archive
download, apply, proven check). The local test profile skips both. Latest
state: release gate run `36497729410` (2026-09-28) passed CFG-11 and failed
CFG-12 with `the send answered 503 while a convergence was parked`. Run
`36522694163` (2026-09-29) failed both on staging timeouts (`524`, network
timeout). Keep the flag on internal projects only until CFG-12 is green.

1. **Prerequisites (already met on prod).**
   - the config archive bucket exists in the target region and the ECS task
     role holds `s3:GetObject` / `s3:PutObject` / `s3:ListBucket` on it (no
     `s3:DeleteObject` — retention is the bucket's lifecycle rule, see
     "Retention" below);
   - every `config_releases` DB migration
     (`packages/db/migrations/20260925105614842_config_release_quarantine.sql`,
     `..._config_releases_bucket.sql`) is applied;
   - `KORTIX_CONFIG_ARCHIVE_RETAIN_PER_PROJECT` is `0` (see "Retention").
   A missing bucket is a boot warning, not an error: every archive request
   then rebuilds from the Git mirror.
2. **Enable one internal project per harness.**
   `PATCH /v1/projects/:projectId/features {feature:"config_releases",enabled:true}`
   on a Kortix-internal OpenCode project and on one with `pi_harness` on (not a
   customer's). Commit an agent or skill change to each project's base branch
   to trigger a real build. The staging gate runs CFG-11/CFG-12 and their
   `-pi` twins.
3. **Watch that project, not the fleet.** Per session:
   - `GET /v1/projects/:projectId/sessions/:sessionId/config` — `release_id`,
     `desired_release_id`, `stale`. `stale: true` for longer than one
     reconnect/reload cycle means convergence did not run.
   - The daemon's `/kortix/health` `config` block — `release_id`,
     `desired_release_id`, `proven`, `fallback_reason`, `failed_release_id`,
     `source` (`release` / `workspace` / `image-default`). The same block on
     both harnesses; `harness.id` names the runtime. `source: "workspace"` while
     the flag is `enabled: true` is a bug — it should never happen once the
     flag is on.
   - API logs, prefix `[config-releases]`: `store put … failed` (archive write
     to S3 failed — the route falls back to streaming the build, not fatal),
     `pruned N archive(s) of project …` (per-project pruning ran — only fires
     when `KORTIX_CONFIG_ARCHIVE_RETAIN_PER_PROJECT > 0`, so with the prod
     value `0` you will not see this line; that is expected), `quarantine
     lookup failed`, `recording assignment failed`.
   - `kortix.config_releases` / `kortix.config_release_failures` rows for the
     project: a release proven (`proven_at` set) vs. failed
     (`failed_release_id` reported by ≥ `PROJECT_QUARANTINE_SESSIONS` = 2
     distinct sessions — see "Fallback chain").
4. **Widen slowly.** One more internal project, then volunteers, then a
   customer project. Flip `platformDefault` to `true` in the registry when
   the rollout is done.

## Fallback chain

Two chains, one on each side of the wire. Neither ever leaves a session
unbootable.

**API side — which release a project's sessions get:**
1. The base branch's current tip (the normal case, always).
2. If that release fails in ≥ `PROJECT_QUARANTINE_SESSIONS` (2) **distinct**
   sessions (`kortix.config_release_failures`), the project quarantines that
   release ID and falls back to the newest release of the same variant any
   session has **proven** (`kortix.config_releases.proven_at`).
   Quarantine is per release ID: a new base commit produces a new release ID
   and is assignable again immediately.
3. If the flag is off for the project: no release is assigned at all; the session reads its workspace config
   directory — pre-release behavior.

**Daemon side — where a box reads config from, per boot/converge:**
1. The API's desired release, downloaded and verified against its manifest.
2. The last release **this box** proved, if the desired release cannot be
   verified or applied (a new OpenCode fails its proven check, or pi refuses
   the config — the running config is kept, nothing is torn down).
3. The platform's image default, if this box has never proved any release.

**Archive store side — cache, not source of truth:** a config archive miss or
S3 read/write failure (`[config-releases] store … failed`) makes the archive
route stream a fresh build from the Git mirror instead of failing the
request. The store is a cache; the Git mirror is always the source of truth.

## Retention

`KORTIX_CONFIG_ARCHIVE_RETAIN_PER_PROJECT=0` in prod means **the API never
prunes archives itself**; the ECS task role holds no `s3:DeleteObject`.
Retention is entirely the bucket's S3 lifecycle rule
(`infra/terraform/modules/project-snapshots-bucket`, `expiration_days = 30`
default, unset by prod so the default applies). An archive is a
content-addressed, immutable cache entry — losing one to expiry only means the
next request for that config tree rebuilds it from the Git mirror. This is
the same pattern already proven in prod by the project-snapshot S3 store,
which shares the bucket and task-role grant.

A positive `KORTIX_CONFIG_ARCHIVE_RETAIN_PER_PROJECT` (dev/staging use `0`
too; the local/self-host default is `20`) makes the API actively delete older
archives of a project after each publish — that path needs
`s3:DeleteObject`, which prod's task role intentionally does not have.
Do not raise this above `0` in prod without also granting that permission.

## Rolling back

**Per project (fast, no deploy):**
```
PATCH /v1/projects/:projectId/features {"feature":"config_releases","enabled":false}
```
Takes effect on the project's next session boot or reload. Stops the one
project; every other enabled project is unaffected.

**Whole platform (requires a deploy):**
Set `available: () => false` on the `config_releases` entry in
`apps/api/src/feature-flags/registry.ts` and ship it. The flag becomes
unavailable for every project at once, the Settings row disappears, and every
session reads its workspace config directory at its next boot or start.
Prefer the per-project flag; reserve this for a defect in the feature itself.

## What NOT to do

- Do not raise `KORTIX_CONFIG_ARCHIVE_RETAIN_PER_PROJECT` above `0` in prod
  without also adding `s3:DeleteObject` to the task role's
  `aws_iam_role_policy.project_snapshots` grant
  (`infra/terraform/modules/ecs-api/main.tf`) — Terraform apply is a human
  action, never CI.
- Do not enable the project flag for a customer project before it has run
  clean on at least one internal project through a real build, a proven
  release, and a session restart.
- Do not treat `source: "workspace"` on a flag-enabled project as anything
  but a bug — file it, do not re-enable the same project until it is
  understood.
