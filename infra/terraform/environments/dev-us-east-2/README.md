# dev-us-east-2 — dev's API/gateway, colocated with the dev database

Dev's API and gateway on ECS Fargate (Spot) in us-east-2, the dev Supabase
database's region. Resource names use `kortix-dev-use2`. `../dev-web-us-east-2`
is the matching web service.

| Surface | Where it runs | Managed by |
|---|---|---|
| `dev-api-use2.kortix.com` | Cloudflare (proxied) → ALB → ECS Fargate (us-east-2) | **this Terraform** |
| `gateway-dev-use2.kortix.com` | Cloudflare (proxied) → ALB → ECS Fargate (us-east-2) | **this Terraform** |
| `dev-use2.kortix.com` | Cloudflare (proxied) → ALB → ECS Fargate (us-east-2) | `../dev-web-us-east-2` |

These are origin hostnames. `dev-api.kortix.com` and `gateway-dev.kortix.com`
are the dev-api Worker (`infra/cloudflare/workers/api-router`), which routes
to them (`ACTIVE_BACKEND = "us-east-2"`). `dev.kortix.com` is a CNAME that
Deploy Dev's `publish-web-ecs-dns` job points at the web ALB.

Deploy Dev applies this root (`terraform-dev-api`) and rolls the task
definitions with `infra/scripts/ecs-deploy.sh dev-use2`. The env blob is
`kortix-dev-env` in us-east-2. `TF_VAR_cloudflare_api_token` is
`CLOUDFLARE_API_TOKEN` in `kortix-ci-env` (us-east-2).

## Why this exists

Server-side `Server-Timing`, same code, same query counts:

| Route | dev (us-west-2 API / us-east-2 DB) | prod (colocated) |
| --- | --- | --- |
| `/accounts/me` | 2084 ms (db 2027 ms) | 24 ms (db 19 ms) |
| `/projects` | 1023 ms (db 1014 ms) | 45 ms (db 32 ms) |

7-13 sequential DB round trips per request, each crossing us-west-2 ↔
us-east-2. Moving the API to us-east-2 removes the cross-continent hop; it
does not remove the sequential-round-trip count (a separate, larger change).

## The move from us-west-2 (done)

Dev ran in us-west-2 (Terraform roots `dev` and `dev-web`, now deleted)
until the move. The move had four phases: stand this root up next to the old
stack, switch the Worker, idle the old stack, destroy it.

- 2026-10-06: the old `kortix-dev`, `kortix-dev-gateway` and `kortix-dev-web`
  services were scaled to 0.
- 2026-10-09: the audit archive was copied (see "Data" below).
- 2026-10-12: the old roots were destroyed (dev 58, dev-web 2 resources) and
  removed from the repository. The old snapshot cache
  `kortix-dev-project-snapshots` was deleted. The us-west-2 copies of
  `kortix-dev-env` and `kortix-dev-web-env` were scheduled for deletion
  (30-day recovery window).

What stays in us-west-2:

| Resource | Why | Delete after |
|---|---|---|
| `kortix-dev-audit-archive` and its KMS key `82a0423e-27d6-4887-9ad6-f242d529bb50` | Deleted on 2026-10-12 with the GOVERNANCE bypass, after the copy in `kortix-dev-use2-audit-archive` was re-verified. The key is scheduled for deletion. | done |
| Terraform state (`kortix-terraform-state`, `kortix-terraform-locks`) | Moved to `kortix-terraform-state-us-east-2-935064898258` (`backend.tf`). | done |

### Phase 4 — decommission (done 2026-10-12)

#### Data

Before a stack moves region, classify every bucket the API reads as a cache
(the API rebuilds it) or a record (no other copy exists). The snapshot bucket
and the config-release archives are caches that the API rebuilds from Git
(`apps/api/src/config-releases/store.ts`). **The audit archive is a record.**
It is the only copy of every week that the archive job removed from
PostgreSQL, and the account audit export reads it from `AUDIT_ARCHIVE_BUCKET`.

| Old data | What happened |
|---|---|
| `kortix-dev-project-snapshots` | Cache. Emptied and deleted on 2026-10-12 (last write 2026-10-06). |
| `kortix-dev-audit-archive` | Copied to `kortix-dev-use2-audit-archive` on 2026-10-09: 622 objects, and all 7 weekly manifests match `manifest_sha256` in `kortix.audit_archive_chunks`. Removed from Terraform state before the destroy. Object Lock holds the old objects until 2027-07-06. |
| ALB log buckets, `/ecs/kortix-dev*` log groups | Deleted on 2026-10-09. |

Copy an audit archive object by object, keeping its bytes, lock and checksum.
The app writes SSE-KMS with no key id (`apps/api/src/object-store/s3.ts`), so
the copy does the same:

```bash
aws s3api copy-object --region <new-region> --bucket <new-bucket> --key "$KEY" \
  --copy-source "<old-bucket>/$KEY?versionId=$VERSION" --metadata-directive COPY \
  --server-side-encryption aws:kms --checksum-algorithm SHA256 \
  --object-lock-mode "$MODE" --object-lock-retain-until-date "$RETAIN_UNTIL"
```

Then prove it: every object's `ChecksumSHA256`, size and lock date match, and
each week's manifest checksum equals `manifest_sha256` in the database. Skip
`verification/lock-probe-*`; it is a manual probe, not archive data.

> ⚠️ `terraform apply` here creates billable AWS resources (VPC, NAT, 2 ALBs,
> Fargate).
