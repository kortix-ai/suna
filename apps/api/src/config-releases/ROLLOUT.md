# Config releases: operations

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

## Status: graduated, no lever

Config releases run for every project. The per-project `config_releases`
feature flag was removed in 2026-10 (the flag-removal PR), after:

- 2026-09-25 to 2026-10-08: the flag on for 4 prod projects. In the 14 days
  to 2026-10-08 they carried 9,230 of 13,733 prod sessions (67%), with 62
  releases, 60 proven. 27 of the 29 failure reports were the 2026-10-02 meta-coordinator
  incident (fixed: the `meta` variant, `notFromMetaSession`).
- #9424 and #9429 (2026-10-08): a tree over the 32 MiB archive cap keeps its
  release, built from the session's checkout or the project snapshot.
  Verified on dev with a 33 MiB repository.

A value a project stored for the flag
(`projects.metadata.experimental.config_releases`) is inert: no code reads it,
and `PATCH /v1/projects/:projectId/features {feature:"config_releases",…}`
answers `400 Unknown feature flag`. The values
stay in the database, so a revert brings back every project's old choice.

There is no per-project switch and no operator switch. The safety net is the
fallback chain below: a release that cannot be built or does not load is never
run; the session keeps a config that loaded.

## Watch

Per session:

- `GET /v1/projects/:projectId/sessions/:sessionId/config` — `release_id`,
  `desired_release_id`, `stale`, `fallback_reason`. `stale: true` for longer
  than one reconnect/reload cycle means convergence did not run.
- The daemon's `/kortix/health` `config` block — `release_id`,
  `desired_release_id`, `proven`, `fallback_reason`, `failed_release_id`,
  `source` (`release` / `workspace` / `image-default`). The same block on both
  harnesses; `harness.id` names the runtime. `source: "workspace"` is a bug on
  a box that can reach a current API.

Fleet:

- API logs, prefix `[config-releases]`: `store put … failed` (archive write
  to S3 failed — the route falls back to streaming the build, not fatal),
  `quarantine lookup failed`, `recording assignment failed`.
- The descriptor route, `POST /v1/projects/:projectId/sessions/:sessionId/config-release`:
  every running box calls it every 60 s (`runtime-truth.ts`), and each call
  resolves the base tip with a `git fetch` of the project mirror. Prod before
  graduation (24 h to 2026-10-08 22:40 UTC): 32,058 answered `200` (p50 886 ms,
  p95 3.3 s, p99 7.5 s, `git;dur` most of it) and 20,910 answered `403
  feature_disabled` in 27 ms (p50). After graduation those `403`s become
  `200`s: about +65% Git work on this route.
- `kortix.config_releases` / `kortix.config_release_failures` rows: a release
  proven (`proven_at` set) vs. failed (`failed_release_id` reported by ≥
  `PROJECT_QUARANTINE_SESSIONS` = 2 distinct sessions — see "Fallback chain").

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
- The descriptor format is `config-release-v3` for a daemon that sends
  `{"accept":["config-release-v3"]}`, else `config-release-v2`. A daemon built
  for v1 (the composed layout) refuses both and keeps its running config until
  the runtime-assets swap gives it the current daemon.

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

There is no per-project lever. A defect in the feature itself is rolled back
by reverting the flag-removal squash commit and deploying. The revert restores
the flag with its OFF platform default: every project that stored no value
goes back to reading its workspace config directory at the next boot or start
of each session's box, and the 4 projects that stored `true` keep releases.
The daemon still handles `403 feature_disabled` (`isFeatureDisabledError`), so
boxes on the new image revert cleanly.

A defect in one project's config is not a rollback: the fallback chain keeps
that project's sessions on the last release that loaded, and
`fallback_reason` names the commit and the error. Fix the config and merge.

## What NOT to do

- Do not raise `KORTIX_CONFIG_ARCHIVE_RETAIN_PER_PROJECT` above `0` in prod
  without also adding `s3:DeleteObject` to the task role's
  `aws_iam_role_policy.project_snapshots` grant
  (`infra/terraform/modules/ecs-api/main.tf`) — Terraform apply is a human
  action, never CI.
- Do not treat `source: "workspace"` on a box that can reach a current API as
  anything but a bug — file it.
