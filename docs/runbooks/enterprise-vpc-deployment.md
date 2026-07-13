# Enterprise VPC deployment and update runbook

## Release flow

`main -> staging -> prod -> customer-zero certification -> stable`

`stable` is a signed release channel, not a moving source branch deployed from
Git. An enterprise version is `<prod-version>-e<revision>`. Promotion copies the
exact certified image and bundle digests; it never rebuilds them.

## Bootstrap order

1. The CLI resolves the AWS target and prints the STS account, ARN, region, and
   planned instance name. It refuses an account mismatch.
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
  --release-repository-url https://releases.kortix.com/enterprise \
  --tuf-root-sha256 "$REVIEWED_TUF_ROOT_SHA256" \
  --updater-bootstrap-url https://releases.kortix.com/enterprise/bootstrap/kortix-enterprise-updater-linux-amd64 \
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

## Normal update

Kortix publishes signed TUF metadata and may send a cross-account EventBridge
wake-up hint. The customer's Step Functions execution starts private CodeBuild.
The updater verifies the pinned bootstrap digest, TUF root/metadata, Cosign
signature, target channel, instance compatibility, migrations, and Terraform
plan classification. It then mirrors immutable images plus the signed OCI
release bundle and rollback metadata into customer ECR, updates Supabase
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
