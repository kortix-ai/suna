# Kortix Capture: a local store with STS (MinIO)

A worktree's API reads and writes Kortix Capture objects in its own Supabase
Storage (bucket `kortix-capture`, created by migration). That covers device
sign-in, ingestion, the timeline, search, policy and ranges. Supabase Storage
has no STS, so `POST /v1/capture/credentials` answers `503
capture_credentials_unavailable`. To issue real per-device credentials
locally, run MinIO, which implements STS AssumeRole with a session policy.

## Run MinIO

The `minio/minio` image is no longer published on Docker Hub (pull access
denied, 2026-10). The Chainguard image works:

```bash
docker run -d --name <slug>-minio -p 37590:9000 -p 37591:9001 \
  -e MINIO_ROOT_USER=capture-root -e MINIO_ROOT_PASSWORD=<local-only-password> \
  -v <slug>-minio:/data cgr.dev/chainguard/minio:latest server /data --console-address :9001
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:37590/minio/health/live   # 200
```

Create the bucket once with any S3 client and the root pair (bucket
`kortix-capture`, path style, region `us-east-1`).

## Point the worktree API at it

The shell environment wins over the worktree defaults
(`scripts/worktree/lib/launch-env.ts`). Keep the values in a gitignored file,
for example `output/capture-minio.env`, and source it before the start:

```bash
export KORTIX_CAPTURE_S3_BUCKET=kortix-capture
export KORTIX_CAPTURE_S3_REGION=us-east-1
export KORTIX_CAPTURE_S3_ENDPOINT=http://127.0.0.1:37590
export KORTIX_CAPTURE_S3_FORCE_PATH_STYLE=true
export KORTIX_CAPTURE_S3_ACCESS_KEY_ID=capture-root
export KORTIX_CAPTURE_S3_SECRET_ACCESS_KEY=<local-only-password>
export KORTIX_CAPTURE_STS_ROLE_ARN=arn:aws:iam::000000000000:role/kortix-capture-device
export KORTIX_CAPTURE_STS_ENDPOINT=http://127.0.0.1:37590
export KORTIX_CAPTURE_INDEX_POLL_SECONDS=5
source output/capture-minio.env && pnpm worktree start <slug> --no-tunnel
```

MinIO ignores the role ARN and enforces the session policy
(`apps/api/src/capture/credentials.ts`). Measured on 2026-10-03 with the root
user as the caller: a device credential writes its own folder, reads
`<prefix>/policy.json`, lists its own folder, and gets `AccessDenied` for another
device's folder, for writing `policy.json`, and for listing the account prefix (`orgs/<account_id>`).

## Limits

- MinIO cannot publish to SQS, so the events reader stays off locally; the
  index reader (`KORTIX_CAPTURE_INDEX_POLL_SECONDS`) and `POST
  …/capture/devices/:id/sync` find new items.
- A MinIO root credential has every permission. Prove the AWS device role and
  the task-role grant on dev after the Terraform apply (learnings 2026-09-14:
  a least-privilege grant needs `s3:ListBucket` for a missing key to answer 404).
