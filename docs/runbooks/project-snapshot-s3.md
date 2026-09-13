# Project snapshot archives (S3 config provider)

A fresh session materializes its project from a prebuilt `.tar.gz` in S3
instead of a Git clone through the proxy. The Git path stays intact as the
default and as the observable fallback.

## Architecture

```
API (leader worker)                              Sandbox (kortixd)
────────────────────                             ───────────────────────────────
push / import / merge / session-create miss      boot → config-provider coordinator
  → kortix.project_snapshot_archives (queued)      mode git        → warm adoption → Git (unchanged path)
  → build from the Git mirror at ONE sha           mode prefer-s3  → warm adoption → S3 → fallback Git
  → S3: <owner>/<repo>/<sha>/<repo-id>/            mode require-s3 → warm adoption → S3, fail closed
       project-snapshot-v1/<sha256>.tar.gz
       (If-None-Match) then manifest.json        S3 = descriptor (Git proxy, KORTIX_TOKEN)
  → row ready                                        → presigned GET (no credential)
session create: ready row → env pin                  → sha256 + gunzip + safe tar → verify → activate
  KORTIX_PROJECT_SNAPSHOT_PIN=sha:sha256:bytes
```

| Piece | Where |
| --- | --- |
| Config | `apps/api/src/config.ts` `KORTIX_PROJECT_SNAPSHOT_*` |
| Storage client (AWS SDK, default credential chain, presign) | `apps/api/src/git-proxy/project-snapshot-store.ts` |
| Ledger + enqueue + build + publish | `apps/api/src/git-proxy/project-snapshot.ts` |
| Leader worker | `apps/api/src/git-proxy/project-snapshot-worker.ts` (started in `startSingletonWorkers`) |
| Descriptor route | `GET /v1/git/{project}.git/project-snapshot?sha=` in `apps/api/src/git-proxy/index.ts` |
| Env pin | `apps/api/src/projects/lib/session-runtime-env.ts` |
| Enqueue sites | registration (`project-registration.ts`), proxy push (`git-proxy/index.ts`), CR merge (`routes/r9.ts`), session-create miss (`lib/sessions.ts`) |
| Ledger table | `kortix.project_snapshot_archives` (migration `20260912214610636_project_snapshot_archives.sql`) |
| Supervisor coordinator | `apps/kortix-sandbox-agent-server/src/config-provider/config-provider.ts` |
| Supervisor transports | `config-provider/git/git-config-provider.ts`, `config-provider/s3/s3-config-provider.ts` |
| Operator tool | `apps/api/scripts/project-snapshot.ts` |
| Boot bench / compat gate | `apps/api/scripts/project-snapshot-bench.ts`, `apps/api/scripts/project-snapshot-compat.ts` |

The archive is the committed tree at one exact commit plus a sanitized
shallow `.git` (one commit, no remote, no hooks, no reflogs, fresh index).
LFS objects are NOT included (pointers only — same as the Git path without
`git lfs`); submodule contents are NOT included (`.gitmodules` only — same as a
clone without `--recurse-submodules`).

## Configuration

API (`apps/api/.env*` via dotenvx, or the deployment's secret blob):

| Variable | Meaning |
| --- | --- |
| `KORTIX_PROJECT_SNAPSHOT_MODE` | `git` (default; rollback) / `prefer-s3` / `require-s3` (acceptance only) |
| `KORTIX_PROJECT_SNAPSHOT_S3_BUCKET` | bucket; unset = producer idle, no S3 anywhere |
| `KORTIX_PROJECT_SNAPSHOT_S3_REGION` | region (falls back to `AWS_REGION`) |
| `KORTIX_PROJECT_SNAPSHOT_S3_PREFIX` | optional key prefix, e.g. `dev/` when environments share a bucket |
| `KORTIX_PROJECT_SNAPSHOT_S3_ENDPOINT` | S3-compatible endpoint override (MinIO). Unset on AWS |
| `KORTIX_PROJECT_SNAPSHOT_S3_PUBLIC_ENDPOINT` | endpoint the SANDBOX reaches, when it differs (MinIO behind a proxy/tunnel). Unset on AWS |
| `KORTIX_PROJECT_SNAPSHOT_S3_FORCE_PATH_STYLE` | `true` for MinIO |
| `KORTIX_PROJECT_SNAPSHOT_S3_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | explicit pair; unset = AWS SDK default chain (task role) |
| `KORTIX_PROJECT_SNAPSHOT_DOWNLOAD_TTL_SECONDS` | presigned URL lifetime (default 900) |
| `KORTIX_PROJECT_SNAPSHOT_MAX_ARCHIVE_BYTES` | producer cap (default 512 MiB) |

Per-project canary override: `projects.metadata.project_snapshot_mode`
(`git` / `prefer-s3` / `require-s3`) wins over the platform mode for that
project's fresh sessions.

Required S3 permissions for the API principal, on the bucket/prefix:
`s3:PutObject`, `s3:GetObject`, `s3:ListBucket` (HeadObject). Conditional
writes (`If-None-Match: *`) need no extra permission. The sandbox needs NO
credential: it receives a presigned GET only.

Recommended bucket policy: private, versioning off, a lifecycle rule expiring
objects after N days (revisions are immutable and rebuildable; the ledger row
is the readiness truth — an expired object shows up as `missing` → Git
fallback and the row can be re-queued with `retry`).

## Local development (MinIO)

```sh
docker run -d --name kortix-project-snapshot-minio -p 127.0.0.1:19100:9000 \
  -e MINIO_ROOT_USER=kortixsnapshot -e MINIO_ROOT_PASSWORD=kortixsnapshotsecret \
  quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z server /data
```

`apps/api/.env.local` (gitignored):

```
KORTIX_PROJECT_SNAPSHOT_MODE=prefer-s3
KORTIX_PROJECT_SNAPSHOT_S3_BUCKET=kortix-project-snapshots
KORTIX_PROJECT_SNAPSHOT_S3_REGION=us-east-1
KORTIX_PROJECT_SNAPSHOT_S3_ENDPOINT=http://127.0.0.1:19100
KORTIX_PROJECT_SNAPSHOT_S3_FORCE_PATH_STYLE=true
KORTIX_PROJECT_SNAPSHOT_S3_ACCESS_KEY_ID=kortixsnapshot
KORTIX_PROJECT_SNAPSHOT_S3_SECRET_ACCESS_KEY=kortixsnapshotsecret
# cloud sandboxes must reach MinIO: `cloudflared tunnel --url http://127.0.0.1:19100`
KORTIX_PROJECT_SNAPSHOT_S3_PUBLIC_ENDPOINT=https://<quick-tunnel>.trycloudflare.com
```

Then `dotenvx run --ignore=MISSING_ENV_FILE -f .env.local -f .env -- bun run scripts/project-snapshot.ts ensure-bucket`.

### Prove the object-store calls on the image's Bun

`apps/api/Dockerfile` pins `BUN_VERSION=1.2` (1.2.23) while laptops and CI run
a newer Bun. `scripts/project-snapshot-s3-probe.ts` exercises the exact SDK
call shapes the store uses and prints one JSON line with `ok`. Run it inside
the image's Bun before touching `project-snapshot-store.ts` or bumping the SDK:

```sh
# from the repo root; Docker Desktop: use the MinIO container's bridge IP as S3_ENDPOINT
docker run --rm -v "$PWD:$PWD:ro" -w "$PWD/apps/api" \
  -e S3_ENDPOINT=http://$(docker inspect -f '{{.NetworkSettings.IPAddress}}' kortix-project-snapshot-minio):9000 \
  oven/bun:1.2-slim bun run scripts/project-snapshot-s3-probe.ts
# → {"ok":true,"bun":"1.2.23","buffer_put_ms":15,"conditional_put_duplicate":"PreconditionFailed/412",…}
```

Known: on Bun 1.2.23 a `PutObject` whose `Body` is a Node `createReadStream`
never completes and pins a core (verified 2026-09-13; a Buffer body of the
same 3 MiB finishes in 15–30 ms). The store therefore uploads the archive as a
whole-file Buffer. Keep it that way, or re-run the probe with the new shape.

The daemon side has the same class of gap: `kortix-agent` is compiled with
`SANDBOX_AGENT_BUN_VERSION=1.3.11`, whose `fetch` re-issues a GET after a
mid-body socket reset and appends the second response to the same body
stream (Bun 1.4 delivers a clean short EOF). Run the coordinator suite under
that Bun before changing `s3-config-provider.ts`:

```sh
# from apps/kortix-sandbox-agent-server; needs git inside the image
docker run --rm -v "$PWD:/app:ro" -w /tmp oven/bun:1.3.11 sh -c \
  'cp -r /app /w && cd /w && apt-get update -qq && apt-get install -y -qq git >/dev/null \
   && git config --global user.email t@t.test && git config --global user.name t \
   && bun install --frozen-lockfile && bun test src/__tests__/config-provider.test.ts'
```

(pnpm-managed checkouts: copy without `node_modules`; `bun install` restores
the daemon's own lockfile.) Expected: 22 pass, 0 fail.

## Preparation, backfill, readiness

All commands run from `apps/api` through the API env
(`dotenvx run --ignore=MISSING_ENV_FILE -f .env.local -f .env -- bun run scripts/project-snapshot.ts …`).

| Command | Effect |
| --- | --- |
| `prepare <projectId> [--ref main] [--sha <40hex>] [--wait]` | resolve the tip (or pin an exact sha), queue it, optionally build inline and print the verified status |
| `status <projectId> [--sha <40hex>]` | ledger row + HeadObject on the archive + manifest presence; exit 0 only when ready and both objects exist |
| `retry <projectId> --sha <40hex>` | re-queue a failed/stuck row |
| `backfill [--limit 50] [--wait]` | queue the default-branch tip of every active project without a ready row (default branches only) |
| `worker-once` | one worker pass in this process |

Automatic enqueue happens on project registration/import, on every successful
push through the Git proxy (tip read with `ls-remote`), on a change-request
merge (exact merged sha), and on a session-create cache miss (the next session
finds it). The leader worker claims rows with `FOR UPDATE SKIP LOCKED`,
retries transient failures 5× with 30 s·2ⁿ backoff (cap 1 h), never
overwrites a published object, and never flips a row to `ready` before both
objects are verified in the bucket.

## Observability

Sandbox (`GET /kortix/health` → `config_provider`):

```json
{"mode":"prefer-s3","provider":"s3","expected_sha":"…","actual_sha":"…","sha_matches":true,
 "s3_attempted":true,"s3_attempts":1,"s3_failed":false,"s3_stage":null,"s3_reason":null,
 "fallback":false,"total_ms":3517,"timings":{"warm":5,"s3_acquire":3479,"s3_activate":31},"outcome":"ok"}
```

A successful Git fallback keeps the S3 failure visible: `s3_failed:true`,
`s3_stage`, `s3_reason` (`missing` | `denied` | `expired-authorization` |
`unavailable` | `timeout` | `malformed` | `digest-mismatch` |
`revision-mismatch` | `limit-exceeded` | `no-pin` | …), `fallback:true`.

Daemon log events: `config_provider_s3_failed` (stage, reason, attempts,
duration, expected sha), `config_provider_fallback`, `config_provider_complete`
(provider, actual sha, per-stage timings), `config_provider_sha_drift`.
Presigned URLs are never logged.

Boot timeline marks relayed to `kortix.provider_events` (kind `boot`):
`config-provider:s3:ok`, `config-provider:s3:failed:<reason>`,
`config-provider:fallback`, `config-provider:git:ok`,
`config-provider:git:fallback`, `config-provider:warm`. Aggregate S3
success/failure/fallback counts and the fallback rate:

```sql
select
  count(*) filter (where marks @> '[{"label":"config-provider:s3:ok"}]')       as s3_ok,
  count(*) filter (where marks::text like '%config-provider:s3:failed:%')      as s3_failed,
  count(*) filter (where marks @> '[{"label":"config-provider:fallback"}]')    as fallbacks,
  count(*) filter (where marks @> '[{"label":"config-provider:git:ok"}]')      as git_ok
from kortix.provider_events
where kind = 'boot' and created_at > now() - interval '1 day';
```

API log: `[project-snapshot] ready` / `build did not complete`
(`project_snapshot_build` events with build/publish ms, bytes, entries), and
the ledger itself (`status`, `attempts`, `last_error`).

## Rollout, canary, rollback

1. Deploy with the bucket configured and `KORTIX_PROJECT_SNAPSHOT_MODE=git`.
   The worker prepares archives; no session consumes them.
2. Backfill (`backfill --wait`) or let pushes/creates queue naturally; check
   `status` on a few projects.
3. Canary: set `metadata.project_snapshot_mode = 'prefer-s3'` on a few
   projects (`update kortix.projects set metadata = metadata || '{"project_snapshot_mode":"prefer-s3"}' where project_id = …`).
   Watch the boot-timeline query above and `config_provider_s3_failed` in
   the daemon logs.
4. Widen with the platform mode `prefer-s3`.
5. Rollback: `KORTIX_PROJECT_SNAPSHOT_MODE=git` (and clear any per-project
   override). No data migration: the ledger and objects are inert.

A daemon change reaches a sandbox only through a new image / runtime-assets
converge (see the `learnings` skill: "A deployed API is not a deployed
daemon"). Prove the guest with
`grep -aoE 'config_provider_s3_failed' /usr/local/bin/kortix-agent` in a
session created after the deploy before flipping any mode.

## Benchmark

`apps/api/scripts/project-snapshot-bench.ts` (see its header): provisions a
fixture project, pushes content through the Git proxy, waits for the archive,
then runs alternating arms of real session boots, recording API ack, `/start`
ready, `runtimeReady`, the daemon's `config_provider` report, boot marks, and
the Git-proxy requests the arm's API logged inside the boot window. Results
and the analysis for this branch are in `docs/runbooks/project-snapshot-s3-benchmark.md`.
