# Config releases: prod rollout

Config releases make a session run the base branch's **current, built**
config, from a read-only release directory — never the session's own
`/workspace` checkout. A release is a checkout of the base branch: the
commit's whole tree, with the same files and folders `/workspace` holds
(`release-tree.ts`). Each harness reads its own dirs inside it exactly as it
reads them in `/workspace` (`harnesses/opencode`, `skills/`, `harnesses/pi`).
The one change from the commit is per-agent plugin selection: an agent variant
drops the plugin entry files its manifest does not select.
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
2. If the tip's release **cannot be built** (the archive is over the limit, a
   plugin an agent selects is missing, a git error), or it fails in ≥
   `PROJECT_QUARANTINE_SESSIONS` (2) **distinct** sessions
   (`kortix.config_release_failures`), the project assigns the newest release
   of the same variant any session has **proven**
   (`kortix.config_releases.proven_at`). Quarantine is per release ID: a new
   base commit produces a new release ID and is assignable again immediately.
   `GET /config` then reports `release.fallback_reason` ("The base branch's
   latest agent config (commit …) could not be built: … / failed to load in 2
   sessions: …. Sessions run the last config that loaded (commit …).") and the
   web header shows "Config failed to load" with that reason.
3. With nothing proven to fall back to, an unbuildable tip is assigned no
   release: each box keeps what it runs, and `fallback_reason` says why.
4. If the flag is off for the project: no release is assigned at all; the session reads its workspace config
   directory — pre-release behavior.

**The meta coordinator is the exception.** A session whose agent is `meta`
(`meta_agent` flag) is never assigned the project's release. It gets the `meta`
variant: the platform's own governance (`buildPlatformMetaOpenCodeConfig`) on
the image default config dir, with no archive. Its release ID does not change
when the base branch moves. Its box holds no project checkout and the meta
image has no `bun`, so a config dir whose tools import a dependency can never
load there. A failure a meta session reported never counts toward the project
quarantine (`notFromMetaSession` in `quarantine.ts`).

**Daemon side — where a box reads config from, per boot/converge:**
1. The API's desired release, from the copy on disk, the checkout, the
   project snapshot or the archive, verified against its manifest.
2. The last release **this box** proved, if the desired release cannot be
   verified or applied (a new OpenCode fails its proven check, or pi refuses
   the config — the running config is kept, nothing is torn down).
3. The platform's image default, if this box has never proved any release.

**Archive store side — cache, not source of truth:** a config archive miss or
S3 read/write failure (`[config-releases] store … failed`) makes the archive
route stream a fresh build from the Git mirror instead of failing the
request. The store is a cache; the Git mirror is always the source of truth.

## Limits

- A box takes a release from the first source that holds it
  (`apps/kortix-sandbox-agent-server/src/services/config-release/obtain.ts`):
  the intact copy on disk, the session's checkout when its HEAD is the
  release commit, the project snapshot of the commit (descriptor `snapshot`,
  v3), then the API archive. Every source is verified file by file against
  the blob IDs. The daemon log line `[boot-config] release materialized`
  names the source in `transport`.
- The API archive is capped at 32 MiB gzip and 128 MiB uncompressed
  (`MAX_CONFIG_ARCHIVE_BYTES` / `MAX_CONFIG_TAR_BYTES` in `release-tree.ts`,
  matched by the daemon's `descriptor.ts` / `boot-config.ts`). The company
  project measured 248 files, 2.6 MB (2026-10-05). A tree over the cap keeps
  its release ID and file list; only the archive is withheld. A v3 daemon
  (`{"accept":["config-release-v3"]}`) gets the release with `archive: null`
  and builds it from its checkout or the snapshot. A v2 daemon gets "no
  release" and the reason, as before v3: it reads `archive: null` as
  governance only.
- The project snapshot is capped at `KORTIX_PROJECT_SNAPSHOT_MAX_ARCHIVE_BYTES`
  (512 MiB gzip by default). Prod measured a largest repository of 220 MiB
  (2026-10-08). Over that cap, or on a deployment without
  `KORTIX_PROJECT_SNAPSHOT_S3_*` (local, self-host), a running box over the
  archive cap cannot converge: it keeps its release, `GET /config` says
  `stale: true`, and the converge reason names both missing sources. A new
  session still builds the release from its own checkout.
- `GET /config`, the turn gate and admission compare against the v3 release
  ID (`resolveDesiredRelease`'s default format). For a tree under the archive
  cap the v2 and v3 IDs are equal. A v2 box on a tree over the cap therefore
  reads `stale: true` until it gets the current daemon.
- A path the repository's `.gitattributes` marks `export-ignore` (the file or
  one of its directories) is left out of the release tree, as `git archive`
  would leave it out (`exportIgnoredPaths` in `release-tree.ts`, KRTX-1728).
  The OpenCode config dir and the manifest always ship whole: the archive's
  own `info/attributes` neutralises both attributes, so blob verification on
  the box matches. A pruned tree is composed, so its archive URL carries the
  commit. `kortix validate` and
  `kortix ship` warn (never fail) when one file is 10 MiB or more or the files
  Git stores total more than 512 MiB (`apps/cli/src/project-lint.ts`, which
  repeats the snapshot cap). The too-large `reason` names both remedies.
- Every commit to the base branch is a new release, because the tree changed.
  Running sessions converge to it in the background; a prompt on a box that is
  behind converges first.
- A tool that imports another file of the repository by a relative path
  (`../../../shared/x`) resolves inside the release exactly as in `/workspace`.
- OpenCode resolves a relative `instructions` entry against the session
  directory (`/workspace`), not its config dir. While OpenCode serves a release,
  the platform plugin `kortix-release-instructions.js`
  (`harness/open-code/release-instructions.ts`) rewrites each relative entry to
  the release root, so `"rules/RULES.md"` reads the base branch's file. URLs,
  `~/`, absolute paths and globs in a directory part keep OpenCode's own
  resolution. The project's `AGENTS.md` is OpenCode's own lookup from
  `/workspace` and is not rewritten.
- The descriptor format is `config-release-v2`. A daemon built for v1 (the
  composed layout) refuses it and keeps its running config until the
  runtime-assets swap gives it the current daemon.

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
