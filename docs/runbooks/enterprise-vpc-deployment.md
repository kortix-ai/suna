# Enterprise VPC deployment and update runbook

The enterprise installation is ECS Fargate, not EKS/Helm. The whole system is
one sentence: **a signed release manifest, three ECS services and a Supabase EC2
behind one ALB, deployed by one CLI command.** See the architecture spec
`docs/specs/2026-07-14-enterprise-ecs-simplification.md` and the module README
`infra/terraform/modules/enterprise-vpc/README.md`.

## Release flow

`main -> staging -> prod -> customer-zero certification -> stable`

`stable` is a signed release channel, not a moving source branch deployed from
Git. An enterprise version is `<prod-version>-e<revision>`. Promotion (the
`Promote Enterprise Stable` workflow) copies the exact certified image and bundle
digests and signs the manifest; it never rebuilds them. Revisions after `e1` must
declare `rollback_from` in their compatibility contract (the workflow rejects an
empty list and requires the immediately preceding published revision).

## Release publisher (Kortix account)

The shared publisher is Terraform-owned in the Kortix AWS account. Its CloudFront
hostname, us-east-1 ACM certificate, Cloudflare validation and CNAME records,
WAF, encrypted WAF logs, immutable request-log bucket, object-locked TUF bucket,
KMS signing keys, and GitHub OIDC roles are one deployment.

The one-time `enterprise-release-publisher-bootstrap` root creates the GitHub
OIDC Terraform role from an authenticated Kortix administrator session. Store its
`terraform_role_arn` output as the repository variable
`ENTERPRISE_PUBLISHER_TERRAFORM_ROLE_ARN`; store the Kortix Cloudflare zone as
`CLOUDFLARE_ZONE_ID`. The protected `enterprise-stable` environment then runs
`Deploy Enterprise Release Publisher`, consuming the existing
`CLOUDFLARE_API_TOKEN` secret without exporting it. Plan is the default; apply
requires the pinned account confirmation and environment approval.

## Bootstrap order

1. The CLI resolves the AWS target and prints the STS account, region, and
   planned instance name. It refuses an account mismatch. `doctor` also prints
   the resolved caller ARN while validating target access. The instance slug must
   NOT start with `kortix-` (every resource is already named `kortix-<instance>`).
2. The `state` root plans locally. Bootstrap IAM/KMS/S3/state-lock changes always
   require explicit customer review.
3. The state root applies, its local state migrates to the new encrypted S3
   backend, and a remote pull verifies lineage and serial before local cleanup.
4. The `cluster` root plans against remote state. Deletes/replacements are
   blocked; the first plan is necessarily manual because it creates trust and
   network boundaries, the ECS cluster/services/ALB, the Supabase EC2, KMS, ECR,
   the release-staging bucket, and the gateway Bedrock grant.
5. After apply, the customer validates ACM DNS records and populates the
   encrypted runtime secret (`kortix self-host env set ...`) without writing
   plaintext Terraform variables.
6. The `platform` root aliases the two application domains (A/AAAA) at the shared
   ALB in the customer Route 53 zone. This is the whole post-cluster step — there
   is no in-cluster platform stage.
7. The operator runs the first `deploy`, which drives the deployer ECS task, and
   then certifies (checklist below).

The permanent customer-zero target is AWS account `935064898258`, region
`us-west-2`, CIDR `10.60.0.0/16`. Essentia (account `327903111249`) is not
touched until customer-zero passes certification with the exact artifact digests
that will be promoted.

## CLI management plane

`kortix self-host` is the one operator surface for Docker and AWS installs. An
AWS target stores only secret-free desired settings and an account pin under the
named instance; the compiled CLI materializes the reviewed Terraform roots and
their complete local module graph there.

```bash
kortix self-host init \
  --target aws-vpc \
  --instance vpc-demo \
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

kortix self-host doctor --instance vpc-demo
kortix self-host plan   --instance vpc-demo
kortix self-host deploy --instance vpc-demo
```

`init`, `configure`, `doctor`, and `plan` do not mutate AWS. `deploy` requires
interactive confirmation or `--yes`, applies a saved classified plan, migrates
bootstrap state into customer S3, and compares remote lineage and serial before
removing the local state. If migration fails, the CLI restores the local backend
declaration and preserves the bootstrap state for a safe retry.

After bootstrap, operational commands read or invoke customer-owned AWS
resources rather than local cached status:

```bash
kortix self-host status   --instance vpc-demo
kortix self-host version  --instance vpc-demo
kortix self-host logs deployer --instance vpc-demo --follow
kortix self-host logs supabase --instance vpc-demo
kortix self-host env ls   --instance vpc-demo
kortix self-host reconcile --instance vpc-demo
kortix self-host update   --instance vpc-demo --release 0.9.84-e1
kortix self-host update   --instance vpc-demo --release 0.9.84-e1 --force
kortix self-host rollback --instance vpc-demo --release 0.9.83-e2
```

Log targets are `deployer`, `supabase`, `api`, `frontend`, and `gateway`.

## Deploy and update mechanics (the deployer task)

`deploy`, `update`, `reconcile`, and `rollback` all run the SAME signed deploy
library, in the customer-owned `kortix-<instance>-deployer` ECS task — the CLI
starts a one-off RunTask and streams its result; the daily EventBridge Scheduler
rule runs the identical task and exits 0 when the running digests already match
the stable manifest. The deployer:

1. verifies the pinned AWS account and TUF-verifies the `stable` manifest;
2. no-ops if the running service digests + Supabase bundle sha (recorded in the
   SSM parameter `/kortix/<instance>/release`, a human-readable breadcrumb, never
   a lock) already match;
3. mirrors the immutable images into customer ECR by digest;
4. if the Supabase bundle changed, stages the verified tarball into the
   KMS-encrypted release-staging S3 bucket and installs it on the EC2 over SSM
   RunCommand, then health-checks Kong;
5. registers new task-def revisions (env + secrets rendered from the runtime
   secret keys, the `ecs-deploy.sh` pattern), runs the migrate task
   (`bun scripts/migrate.ts bootstrap`) to exit 0;
6. rolls `api -> gateway -> frontend` and waits for `services-stable`; the ECS
   deployment circuit breaker rolls back a bad task-def automatically;
7. runs public health checks and writes the SSM release breadcrumb.

There is no Step Functions, CodeBuild, or release-state/lease table: live ECS
state is the release state, and ECS serializes deployments per service.

## Rollback

`rollback --release <v>` is a deploy of an older signed revision. It is allowed
only when the target manifest lists the current revision as a valid predecessor
in `rollback_from`. A database rollback is safe only when the manifest declares a
tested reverse/forward-compatible migration path; otherwise a data restore is a
reviewed recovery operation (below). Exercise a rollback once on customer-zero.

## Backup and restore (whole-volume)

Durability is encrypted EBS + hourly AWS Backup recovery points (`backup.tf`,
vault-locked). There is no custom log-shipping or point-in-time database machine
on the host; recovery is a **whole-volume restore** of the Supabase data volume
to the most recent recovery point, so the RPO tracks the ~60-minute snapshot
cadence.

To recover:

1. Confirm a recent recovery point exists in the `<instance>-supabase` backup
   vault (`aws backup list-recovery-points-by-backup-vault`).
2. Stop the Supabase stack on the host (`kortix self-host logs supabase` to
   confirm; the stack is systemd-managed).
3. Restore the recovery point to a new encrypted EBS volume
   (`aws backup start-restore-job`), detach the current data volume, and attach
   the restored volume at `/dev/sdf`.
4. Start Supabase and verify the authenticated Kong health endpoint, then confirm
   application reads through the API.

Certification is not complete until a real marker row survives a restore to the
latest recovery point, the application reads it through the API, and the restore
procedure is recorded.

## Documented v1 limitations

- **Sandboxes** run on Daytona via NAT egress (`ALLOWED_SANDBOX_PROVIDERS=daytona`).
  Single-tenant in-VPC sandboxes are a separate project.
- **LLM upstream** is AWS Bedrock. The gateway authenticates managed Claude with
  the `AWS_BEDROCK_API_KEY` bearer key (an operator-required runtime value); the
  gateway task role's SigV4 `bedrock:InvokeModel[WithResponseStream]` grant is
  provisioned but latent until the gateway supports SigV4 credentials directly.
  Enterprise deployments do NOT depend on OpenRouter.

## Certification checklist (per deployment)

- [ ] `terraform apply` clean from the generated env roots (state -> cluster -> platform)
- [ ] all 3 ECS services stable on the expected digests; migrate task exit 0
- [ ] Supabase authenticated health through Kong
- [ ] API `/v1/health` 200 with the expected version; frontend 200
- [ ] sign-up/sign-in + one real project/session flow persists data
- [ ] one agent turn completes against Bedrock (no OpenRouter)
- [ ] an AWS Backup recovery point exists; restore procedure documented
- [ ] the daily scheduled deployer task ran once and no-oped cleanly
- [ ] rollback to the previous revision exercised once (customer-zero only)

## Stop conditions

Do not auto-apply when the guard reports `manual_review` or `blocked`, any
signature/digest check fails, the installed account/region differs, a release is
not on `stable`, migrations are incompatible, or post-deploy health gates fail.
Do not replace a host or restore data until the current backup recovery point and
rollback target are recorded.
