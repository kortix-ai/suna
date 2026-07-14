# Enterprise VPC deployment and update runbook

## Release flow

`main -> staging -> prod -> customer-zero certification -> stable`

`stable` is a signed release channel, not a moving source branch deployed from
Git. An enterprise version is `<prod-version>-e<revision>`. Promotion copies the
exact certified image and bundle digests; it never rebuilds them.

The shared publisher is Terraform-owned in the Kortix AWS account. Its
CloudFront hostname, us-east-1 ACM certificate, Cloudflare validation and CNAME
records, WAF, encrypted WAF logs, immutable request-log bucket, object-locked
TUF bucket, KMS signing keys, and GitHub OIDC roles are one deployment.

The one-time `enterprise-release-publisher-bootstrap` root creates the GitHub
OIDC Terraform role from an authenticated Kortix administrator session. Store
its `terraform_role_arn` output as the repository variable
`ENTERPRISE_PUBLISHER_TERRAFORM_ROLE_ARN`; store the Kortix Cloudflare zone as
`CLOUDFLARE_ZONE_ID`. The protected `enterprise-stable` environment then runs
`Deploy Enterprise Release Publisher`, consuming the existing
`CLOUDFLARE_API_TOKEN` secret without exporting it. Plan is the default; apply
requires the pinned account confirmation and environment approval.

For emergency local recovery only, supply the scoped Cloudflare credential at
apply time:

```bash
export TF_VAR_cloudflare_api_token="$(dotenvx get CLOUDFLARE_API_TOKEN -f apps/api/.env)"
terraform -chdir=infra/terraform/environments/enterprise-release-publisher plan
```

Never write that token into `terraform.tfvars` or state. The provider uses it
for DNS writes but does not persist it as a managed resource attribute.

## Bootstrap order

1. The CLI resolves the AWS target and prints the STS account, region, and
   planned instance name. It refuses an account mismatch. `doctor` also prints
   the resolved caller ARN while validating target access.
2. The `state` root plans locally. Bootstrap IAM/KMS/S3/DynamoDB changes always
   require explicit customer review.
3. The state root applies, its local state migrates to the new encrypted S3
   backend, and a remote pull verifies lineage and serial before local cleanup.
4. The `cluster` root plans against remote state. Deletes/replacements are
   blocked; the first plan is necessarily manual because it creates trust and
   network boundaries.
5. After apply, the customer validates ACM DNS records and populates the
   encrypted runtime secret without writing plaintext Terraform variables.
6. Customer CodeBuild applies the `platform` root through the private EKS
   endpoint and reconciles the certified release.
7. Certification proves API, frontend, auth, sandbox execution, persistence,
   observability, backup/WAL restore, upgrade, rollback, missed-event recovery,
   invalid-signature rejection, node loss, and Supabase host recovery.

The permanent customer-zero target is AWS account `935064898258`, region
`us-west-2`, CIDR `10.60.0.0/16`. Essentia is not touched until customer-zero
passes the complete certification matrix with the exact artifact digests that
will be promoted.

## CLI management plane

`kortix self-host` is the one operator surface for Docker and AWS installs.
Docker commands keep their existing behavior. An AWS target stores only
secret-free desired settings and an account pin under the named instance; the
compiled CLI materializes the reviewed Terraform roots and their complete
local module graph there.

```bash
kortix self-host init \
  --target aws-vpc \
  --instance kortix-vpc-demo \
  --aws-profile default \
  --region us-west-2 \
  --vpc-cidr 10.60.0.0/16 \
  --api-domain api.vpc-demo.kortix.com \
  --frontend-domain vpc-demo.kortix.com \
  --route53-zone-id "$CUSTOMER_PUBLIC_ZONE_ID" \
  --release-repository-url https://releases.kortix.com \
  --tuf-root-sha256 "$REVIEWED_TUF_ROOT_SHA256" \
  --updater-bootstrap-url "https://releases.kortix.com/bootstrap/$CERTIFIED_SOURCE_SHA/kortix-enterprise-updater-linux-amd64" \
  --updater-bootstrap-sha256 "$REVIEWED_UPDATER_SHA256" \
  --release-publisher-account-id 935064898258 \
  --maintenance-window Sun:02:00-05:00 \
  --yes

kortix self-host doctor --instance kortix-vpc-demo
kortix self-host plan --instance kortix-vpc-demo
kortix self-host deploy --instance kortix-vpc-demo
```

`init`, `configure`, `doctor`, and `plan` do not mutate AWS. `deploy` requires
interactive confirmation or `--yes`, applies a saved classified plan, migrates
bootstrap state into customer S3, and compares remote lineage and serial before
removing the local state. If migration fails, the CLI restores the local
backend declaration and preserves the bootstrap state for a safe retry.

After bootstrap, operational commands read or invoke customer-owned AWS
resources rather than relying on local cached status:

```bash
kortix self-host status --instance kortix-vpc-demo
kortix self-host version --instance kortix-vpc-demo
kortix self-host logs updater --instance kortix-vpc-demo --follow
kortix self-host logs supabase --instance kortix-vpc-demo
kortix self-host reconcile --instance kortix-vpc-demo
kortix self-host update --instance kortix-vpc-demo --release 0.9.84-e1
kortix self-host update --instance kortix-vpc-demo --release 0.9.84-e1 --force
kortix self-host rollback --instance kortix-vpc-demo --release 0.9.83-e2
```

Update, force, reconcile, and rollback only start the customer Step Functions
state machine. The CLI cannot bypass the updater's signature, digest,
compatibility, account, Terraform-plan, migration, or health gates.

## Point-in-time recovery

Every signed Supabase bundle contains `bin/pitr-restore`. It restores an exact
base-backup manifest plus the customer-owned WAL archive; it does not accept an
arbitrary S3 key. Before stopping Supabase it verifies the manifest contract,
download length, full SHA-256 checksum, tar paths, WAL filenames, target time,
and active instance name. It then atomically acquires `recovery_in_progress` in
the release-state table. The normal updater cannot acquire its lease while
that flag exists.

Select the latest complete base backup and a UTC target after that backup but
not in the future:

```bash
STATUS=$(kortix self-host status --instance kortix-vpc-demo --json)
INSTANCE_ID=$(jq -r '.supabase.instance_id' <<<"$STATUS")
BASE_KEY=$(jq -r '.release.last_base_backup_key' <<<"$STATUS")
MANIFEST_KEY="${BASE_KEY%/base.tar.gz}/manifest.json"
TARGET_TIME=2026-07-13T11:00:00Z

COMMAND_ID=$(aws ssm send-command \
  --profile default \
  --region us-west-2 \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --parameters commands="sudo /opt/kortix/current/bin/pitr-restore --manifest-key '$MANIFEST_KEY' --target-time '$TARGET_TIME' --confirm-instance kortix-vpc-demo" \
  --query 'Command.CommandId' \
  --output text)

aws ssm get-command-invocation \
  --profile default \
  --region us-west-2 \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID"
```

The restore first starts only PostgreSQL, waits until recovery reaches the
requested time and promotes, and only then starts the complete Supabase stack.
The previous data directory is retained as
`/var/lib/kortix/postgres.pre-pitr-<timestamp>`. If PostgreSQL cannot reach the
target, the script automatically restores that directory and restarts the
original stack. If even that restart fails, `recovery_in_progress` remains set
so unattended releases stay fail-closed.

For a large production database, attach a fresh encrypted recovery EBS volume
or use a replacement Supabase host so the base archive, restored cluster, WAL,
and quarantined prior cluster have sufficient capacity. Certification is not
complete until a real marker row is restored to the requested timestamp, the
application reads it through the API, the old cluster remains quarantined, and
the release-state restore coordinates match the S3 manifest.

## Normal update

Kortix publishes signed TUF metadata and may send a cross-account EventBridge
wake-up hint. The customer's Step Functions execution starts private CodeBuild.
The updater verifies the pinned bootstrap digest, TUF root/metadata, Cosign
signature, target channel, instance compatibility, migrations, and Terraform
plan classification. It then mirrors only the immutable runtime images into
customer ECR, downloads the authenticated TUF bundles, updates Supabase
through SSM, reconciles EKS, runs health gates, and records the
result in customer DynamoDB. An hourly schedule performs the same source-of-
truth check if hints are missed.

## Force, rollback, and break glass

- A forced execution sets `force=true` and only bypasses the maintenance
  window. It cannot bypass signatures, digest checks, migration compatibility,
  plan guard, account guard, or health gates.
- Rollback selects a previously verified enterprise manifest and digest set.
  Database rollback is allowed only when that manifest declares a tested
  reverse/forward-compatible migration path; otherwise restore is a reviewed
  recovery operation.
- Operator access is optional, customer-approved, external-ID protected, and
  expires after one hour. Use SSM, never SSH. Every action is recorded in
  CloudTrail, CloudWatch, Step Functions, CodeBuild, and release-state history.

## Stop conditions

Do not auto-apply when the guard reports `manual_review` or `blocked`, any
signature/digest check fails, the installed account/region differs, a release
is not on `stable`, backup/WAL health is stale, migrations are incompatible, or
post-update health gates fail. Do not replace a host or restore data until the
current EBS/WAL recovery point and rollback target are recorded.
