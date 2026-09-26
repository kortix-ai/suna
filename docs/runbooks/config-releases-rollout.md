# Config releases: prod rollout

Config releases make a session run the base branch's **current, built**
OpenCode config, from a read-only release directory — never the session's own
`/workspace` checkout. Full contract: `apps/api/src/config-releases/`,
`apps/kortix-sandbox-agent-server/src/config-release/`,
`apps/kortix-sandbox-agent-server/src/harness/open-code/config-release.ts`.

## The two levers

Two independent gates. Both must be on for a session to run a release.

| Lever | Scope | Set by | Changed by |
|---|---|---|---|
| `CONFIG_RELEASES_ENABLED` | Whole platform | Operator, at deploy time | `KORTIX_ECS_ENV_OVERRIDES` in `.github/workflows/deploy-prod.yml` → redeploy |
| `config_releases` project flag | One project | Project owner/admin, at any time | `PATCH /v1/projects/:projectId/features {feature:"config_releases",enabled:true|false|null}` |

`available` (the switch) AND-gates `enabled` (the flag). Both default to
**off**. Turning the switch on by itself changes no session's behavior — every
project's flag still defaults to `enabled: false`
(`apps/api/src/feature-flags/registry.ts`, `platformDefault: () => false`).
A project must separately opt in.

With the switch off: the Settings row is hidden, the descriptor and archive
routes answer `403 feature_disabled` for every project, no convergence is
scheduled, and every session reads its workspace config directory directly —
today's behavior, unchanged.

## Rollout order

**Precondition, before step 1: CFG-11 and CFG-12 must pass against deployed
staging in a release gate run.** Every other config-releases flow (CFG-1
through CFG-10) is API-only and can pass with no sandbox ever booting.
CFG-11 and CFG-12 are the only two flows that `requires: funded, daytona` —
the only ones that boot a real sandbox and prove the daemon side of this
feature (descriptor fetch, archive download, apply, and the proven check)
actually works end to end. The local test profile skips both, so this is
also the only place they run. As of the v0.13.33 release gate, CFG-1..CFG-10
pass and CFG-11/CFG-12 both fail at their first assertion with
`"source":"image-default"` and a `fallback_reason` naming a failed release —
i.e. the box never applies the release it was assigned and falls all the way
back to the image default. Do not flip the prod switch (step 1) until both
flows are green on a deployed staging release gate run. Root cause is being
worked on a separate branch.

1. **Merge the switch, prerequisites already proven.** Adding
   `"CONFIG_RELEASES_ENABLED":"true"` to `deploy-prod.yml`'s
   `KORTIX_ECS_ENV_OVERRIDES` makes the flag *available*. Confirm before
   merging (see the PR that added this runbook for a worked example):
   - the config archive bucket exists in the target region and the ECS task
     role holds `s3:GetObject` / `s3:PutObject` / `s3:ListBucket` on it (no
     `s3:DeleteObject` — retention is the bucket's lifecycle rule, see
     "Retention" below);
   - every `config_releases` DB migration
     (`packages/db/migrations/20260925105614842_config_release_quarantine.sql`,
     `..._config_releases_bucket.sql`) is already applied on prod;
   - `KORTIX_CONFIG_ARCHIVE_RETAIN_PER_PROJECT` is `0` (see "Retention").
   Deploy. The Settings row now appears for every project; nothing else
   changes.
2. **Enable one internal project.**
   `PATCH /v1/projects/:projectId/features {feature:"config_releases",enabled:true}`
   on a Kortix-internal project (not a customer's). Commit an
   `.opencode`/agent config change to that project's base branch to trigger a
   real build.
3. **Watch that project, not the fleet.** Per session:
   - `GET /v1/projects/:projectId/sessions/:sessionId/config` — `release_id`,
     `desired_release_id`, `stale`. `stale: true` for longer than one
     reconnect/reload cycle means convergence did not run.
   - The daemon's `/kortix/health` `config` block —
     `outcome` (`applied` / `unchanged` / `declined` / `quarantined` /
     `failed`), `proven`, `fallback_reason`, `source`
     (`release` / `workspace` / `image-default`). `source: "workspace"` while
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
4. **Widen slowly.** One more internal project, then ask for volunteers, then
   a customer project. There is no fleet-wide "enable all" switch by design —
   each project opts in individually.

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
3. If the flag is off for the project (or the switch is off platform-wide):
   no release is assigned at all; the session reads its workspace config
   directory — pre-release behavior.

**Daemon side — where a box reads config from, per boot/converge:**
1. The API's desired release, downloaded and verified against its manifest.
2. The last release **this box** proved, if the desired release cannot be
   verified or applied (a new OpenCode fails its proven check — the running
   process is kept, nothing is torn down).
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

**Whole platform — the kill switch (requires a deploy):**
Set `CONFIG_RELEASES_ENABLED` back to unset/`false` in `deploy-prod.yml`'s
`KORTIX_ECS_ENV_OVERRIDES` and redeploy. This is the same lever as the
rollout's step 1, in reverse: the flag becomes unavailable for every project
at once, the Settings row disappears, and every session falls back to
reading its workspace config directory. There is no in-place runtime toggle
for the platform switch — `available` reads a compiled-in env var
(`apps/api/src/feature-flags/registry.ts`), not a database row, so clearing it
always means an ECS task-definition update. Prefer the per-project flag
during an active rollout; reserve the platform switch for a defect in the
feature itself, not for one bad project.

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
