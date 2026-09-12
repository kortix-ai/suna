# Repository snapshots (Config Provider v1)

A prepared GitHub-backed project starts from an immutable S3 archive instead of
a Git fetch. The archive is downloaded and extracted concurrently, verified, and
then activated. Editing, commit, push and change requests are unchanged.

> **"repo snapshot" is the Git SOURCE archive.** `kortix.project_snapshot_builds`
> is a different thing — the per-project sandbox IMAGE build. The two never
> share a table, a worker, or a term.

## 1. What exists

| Piece | Path |
| --- | --- |
| Format contract, key layout, manifest validation | `apps/api/src/repo-snapshots/format.ts` |
| Producer (exact SHA, sanitized, project-neutral) | `apps/api/src/repo-snapshots/build.ts` |
| S3 access (SigV4 GET/PUT/HEAD, presigned GET) | `apps/api/src/repo-snapshots/s3.ts` |
| Publication (conditional create, adopt winner) | `apps/api/src/repo-snapshots/publish.ts` |
| Ledger and observed revisions | `apps/api/src/repo-snapshots/store.ts` |
| Publisher + reconciler worker | `apps/api/src/repo-snapshots/worker.ts` |
| Preparation entry points | `apps/api/src/repo-snapshots/prepare.ts` |
| Push ingestion | `apps/api/src/repo-snapshots/webhook.ts` |
| Session pin (no Git, no GitHub) | `apps/api/src/repo-snapshots/session-pin.ts` |
| API-side source reads | `apps/api/src/repo-snapshots/source-reader.ts` |
| Descriptor route | `GET /v1/git/{project}/repo-snapshot` |
| Sandbox consumer | `apps/kortix-sandbox-agent-server/src/repo-snapshot.ts` |
| Backfill / reconcile | `apps/api/scripts/backfill-repo-snapshots.ts` |
| Materialization benchmark | `apps/api/scripts/bench-repo-snapshot.ts` |
| Boot attribution | `apps/api/scripts/bench-boot-attribution.ts` |

Tables: `kortix.repo_snapshots` (publication ledger) and
`kortix.repo_snapshot_refs` (the latest SHA the control plane has OBSERVED per
ref, tracked separately so a slow build of an older commit can never replace a
newer desired revision).

## 2. Object layout

```text
<owner>/<repo>/<full-commit-sha>/<repository-id>/project-snapshot-v1/manifest.json
<owner>/<repo>/<full-commit-sha>/<repository-id>/project-snapshot-v1/<archive-sha256>.tar.gz
```

- `<repository-id>` is GitHub's stable numeric id, not a Kortix project id. Its
  position below the SHA is what stops a NEW repository that reuses an old
  owner/name and lands on the same commit from colliding with the old manifest.
- `<archive-sha256>` hashes the stored COMPRESSED bytes. It is not the commit
  SHA and not the S3 ETag.
- The extension always matches the manifest's `compression`.

## 3. Configuration

| Variable | Meaning |
| --- | --- |
| `KORTIX_REPO_SNAPSHOT_MODE` | `off` \| `shadow` \| `prefer` \| `required`. Default `off`. |
| `KORTIX_REPO_SNAPSHOT_BUCKET` | Private, environment-scoped bucket. Empty ⇒ every mode behaves as `off`. |
| `KORTIX_REPO_SNAPSHOT_REGION` | Bucket region. Default `us-east-1`. |
| `KORTIX_REPO_SNAPSHOT_PREFIX` | Key prefix separating dev/staging/prod inside one bucket. |
| `KORTIX_REPO_SNAPSHOT_ENDPOINT` | S3-compatible endpoint (MinIO/LocalStack). Forces path-style. |
| `KORTIX_REPO_SNAPSHOT_ACCESS_KEY_ID` / `..._SECRET_ACCESS_KEY` | Static writer credentials. Unset ⇒ the ambient AWS chain (ECS task role, EKS web identity), same as SES. |
| `KORTIX_REPO_SNAPSHOT_COMPRESSION` | `gzip` (default) or `zstd`, for NEW archives only. Readers accept both. |
| `KORTIX_REPO_SNAPSHOT_URL_TTL_SECONDS` | Capability lifetime. Default 3600. |
| `KORTIX_REPO_SNAPSHOT_DELIVERY` | `presigned` (default) or `proxy`. |
| `KORTIX_REPO_SNAPSHOT_WORKER_ENABLED` | Stop publishing without changing consumption. |
| `KORTIX_REPO_SNAPSHOT_RECONCILE_INTERVAL_MINUTES` | Re-resolution cadence for refs with no usable webhook. Default 15. |
| `KORTIX_REPO_SNAPSHOT_WEBHOOK_SECRET` | Extra accepted webhook secret (self-host, repo-level hook). |
| `KORTIX_REPO_SNAPSHOT_CACHE_DIR` | API-side extracted-snapshot cache. Default `$TMPDIR/kortix/repo-snapshots/cache`. |

`KORTIX_REPO_SNAPSHOT_MODE` is **independent of `KORTIX_COMPILED_BOOT_MODE`.**
The compiled-boot flag also enables the experimental OpenCode launcher; enabling
snapshot transport must never drag that in.

### Bucket

Private, no public access, SSE enabled, versioning off (objects are immutable
and content-addressed). The writer needs `s3:PutObject` and `s3:GetObject` on
`<bucket>/<prefix>*`.

`s3:HeadObject` is **not** an IAM action — a `HEAD` request is authorized by
`s3:GetObject`, so the publisher's existence checks need no extra permission.
Nothing is ever granted `s3:ListBucket` or `s3:DeleteObject` by the API, and the
sandbox receives only an object-scoped presigned GET, never a bucket-level
capability. A presigned URL cannot exceed the signer's own permissions, so the
writer role stays the ceiling.

Retention: keep every referenced artifact. Expire incomplete multipart uploads
after 1 day. Do not add an age-based expiry: a session pinned to an older
revision and a rollback both read artifacts that are not the current tip.

### Delivery mode

| Mode | The sandbox fetches | Use it when |
| --- | --- | --- |
| `presigned` | Object storage directly, with a short-lived object-scoped GET. No Kortix credential is sent. | The sandbox can route to the bucket. Lowest cost, no API bandwidth. |
| `proxy` | `GET /v1/git/{project}/repo-snapshot/archive?sha=…` on this API, with its own session bearer. | The object store is **not reachable from a sandbox**: self-host, preview, and any local stack whose storage is on loopback. |

In `proxy` mode the object key is derived from the **authorized project row** and
the requested SHA, so a caller cannot name another repository's object, and the
bucket name never reaches the client.

The daemon attaches its Kortix token **only** when the descriptor says `bearer`
AND the URL is on the control plane's own origin (`archiveRequestHeaders` in
`apps/kortix-sandbox-agent-server/src/repo-snapshot.ts`). A descriptor that asks
for a bearer against any other host — including a legitimate S3 host — is
refused, because that is the shape a tampered descriptor takes and the cost of
honouring it is the session credential.

## 4. Rollout

```text
publisher + backfill → shadow → selected projects in prefer → measured coverage → required
```

1. **Publisher only.** Set the bucket and credentials, leave
   `KORTIX_REPO_SNAPSHOT_MODE=off`. Snapshots are produced and nothing consumes
   them.
2. **Backfill.**
   ```sh
   cd apps/api
   dotenvx run -f .env.local -f .env -- bun run scripts/backfill-repo-snapshots.ts --dry-run --json /tmp/backfill.json
   dotenvx run -f .env.local -f .env -- bun run scripts/backfill-repo-snapshots.ts --json /tmp/backfill.json
   ```
   The report lists every project it could NOT prepare, with the reason. Read
   that list; it is the coverage gap, not noise.
3. **`shadow`.** The existing path still serves. The snapshot is fetched,
   verified and discarded, so a failure never touches the live workspace or
   gates readiness.
4. **`prefer`.** The ready artifact serves first; an eligible recoverable
   failure falls back to Git at the SAME SHA and is counted.
5. **`required`.** No automatic Git fallback. A missing artifact is a bounded
   pending state or a clear retryable error. Enable only for cohorts whose
   coverage and benchmark evidence you have actually read.

Authorization, identity and integrity failures never become a fallback to
another revision. Retries stay bound to the pinned SHA; a newer tip requires a
new binding.

## 5. Rollback

Set `KORTIX_REPO_SNAPSHOT_MODE=off` and redeploy the API.

- It affects NEW materializations only. Sessions already running keep their
  workspaces.
- No snapshot is deleted; re-enabling serves the same artifacts.
- To stop producing as well, set `KORTIX_REPO_SNAPSHOT_WORKER_ENABLED=false`.
  Consumption and production are separate switches on purpose.

## 6. Preparation coverage

| Path | Trigger | Covered |
| --- | --- | --- |
| Kortix proxy push | `git-receive-pack` 2xx | Yes |
| Project create / import / link | `registerLinkedProject` | Yes |
| External push, GitHub App created after this change | `push` webhook | Yes |
| External push, GitHub App created BEFORE this change | — | **No.** Its manifest declared `hook_attributes.active: false`, and GitHub exposes no API to retrofit an existing App's hook. Reconciliation covers it. |
| External push, PAT-linked project | — | **No webhook.** Reconciliation covers it. |
| Any ref, any auth mode | Reconciliation every `KORTIX_REPO_SNAPSHOT_RECONCILE_INTERVAL_MINUTES` | Yes |

Freshness is therefore "the latest authorized SHA the control plane has
OBSERVED". Startup cannot prove an unobserved GitHub HEAD without a remote
lookup. The pin records when the ref was observed and through which path, and an
explicit-SHA request stays exact.

## 7. Metrics to watch

Structured log lines, repo/SHA in the payload rather than in metric labels:

- `[repo-snapshot] built` — compressed/expanded bytes, entry count, submodule
  and LFS-pointer counts.
- `[repo-snapshot] published` / `adopted concurrent publication`.
- `[repo-snapshot] session pinned a prepared revision` — mode, SHA, how and when
  the revision was observed.
- `[repo-snapshot] session fell back` — the miss reason.
- `[repo-snapshot] build attempt failed` — attempt, budget, permanent or not.
- `[git] repo materialized from snapshot` (sandbox) — transfer, first-entry and
  extract times, attempts.
- `/kortix/health` → `repo_snapshot` and `git_network_ops`. A prepared start
  reports `git_network_ops: 0`.

## 8. Verification

```sh
# Producer, format, descriptor, webhook (hermetic)
cd apps/api && bash scripts/test.sh

# Real S3 protocol, publication lifecycle, and the Git-blocked end-to-end proof
docker run -d --name kortix-snapshot-minio -p 19000:9000 \
  -e MINIO_ROOT_USER=kortixsnapshots -e MINIO_ROOT_PASSWORD=kortixsnapshots123 \
  quay.io/minio/minio:latest server /data
docker exec kortix-snapshot-minio mc alias set local http://127.0.0.1:9000 kortixsnapshots kortixsnapshots123
docker exec kortix-snapshot-minio mc mb --ignore-existing local/kortix-repo-snapshots
cd apps/api && dotenvx run -f .env.local -f .env -- bun test --isolate \
  src/repo-snapshots/s3-publish.integration.test.ts \
  src/__tests__/integration-repo-snapshot-lifecycle.test.ts \
  src/__tests__/integration-repo-snapshot-e2e.test.ts

# Sandbox streaming, guards and limits
cd apps/kortix-sandbox-agent-server && bun test src/__tests__/repo-snapshot.test.ts

# Materialization benchmark (writes raw.json, results.csv, report.md)
cd apps/api && bun run scripts/bench-repo-snapshot.ts \
  --repo small=<path> --repo median=<path> --repo large=<path> --repo many-small=<path> \
  --rounds 30 --warmups 2 --codec both --out docs/benchmarks/repo-snapshots

# Deployed session boot, including git_network_ops
cd apps/api && BENCH_TARGETS='[{"label":"dev","projectId":"<uuid>"}]' \
  BENCH_DB_URL=… BENCH_TOKEN=… BENCH_API=https://dev-api.kortix.com \
  bun run scripts/bench-boot-attribution.ts
```
