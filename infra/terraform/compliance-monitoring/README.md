# compliance-monitoring

Regional, discovery-based SOC 2 monitoring for the Kortix AWS account. This
stack has its own state so it cannot accidentally adopt or mutate the legacy
`security-baseline` stack.

It manages:

- WAF association for every current ALB in us-west-2, eu-west-2, and
  us-east-2.
- Target-response-time, ELB 5xx, and unhealthy-host CloudWatch alarms for every
  current ALB, with regional SNS actions (Drata DCF-86 / DCF-88 / test 294).
  The reconciler adds a zero-healthy-hosts alarm per target group.
  `TargetResponseTime` was retired on 2026-08-26 because its 2 s threshold
  flapped on streaming traffic; it is restored at Average > 30 s sustained for
  15 minutes, above the by-design streaming averages.
- CPU-utilization CloudWatch alarms for every running EC2 instance in the dev
  and production regions, discovered on every plan so replacement EKS workers
  remain covered (Drata DCF-86).
- Regional Lambda reconcilers triggered by EC2 running-state events, plus a
  five-minute repair schedule, so replacement instances receive the same alarm
  without waiting for another Terraform apply.
- Regional Lambda reconcilers on a five-minute schedule, so Kubernetes-managed
  ALB creation and replacement receives all four required alarms without
  waiting for another Terraform apply. The same run deletes the
  per-target-group `kortix-alb-*-target-response-time` variants the Lambda
  itself created in the retired 2 s-threshold era, and the unmanaged
  `compliance-*` ALB alarms left by the 2026-07-27 evidence pass.
- Least-privilege SNS topic policies for EventBridge and CloudWatch delivery.
- AWS Backup and EBS snapshot failure EventBridge rules and SNS targets
  (Drata DCF-99).
- A restricted us-east-2 network ACL, a locked default security group, and VPC
  flow logs (Drata DCF-25 / DCF-97).
- A versioned, KMS-encrypted S3 bucket and an EKS IRSA role for daily Velero
  backups. Velero retains backups for 30 days. S3 expires current and
  noncurrent object versions after 35 days.

Kubernetes-managed ALB names contain generated hashes, so the stack discovers
all current ALB ARNs. Re-run plan/apply after adding or replacing a load
balancer to bring the new ARN under management.

## First adoption

The resources were created live before this stack was introduced. Initialize
and run `scripts/import-live.sh` to adopt WAF associations, which cannot be
upserted. CloudWatch alarms, EventBridge rules/targets, and SNS policies use
idempotent AWS put operations and are adopted by the first apply. Then require
a zero-destroy plan:

```bash
terraform init
./scripts/import-live.sh
terraform plan -out=tfplan
terraform show -json tfplan | jq -e '[.resource_changes[]? | select(.change.actions | index("delete"))] | length == 0'
terraform apply tfplan
```

Email SNS subscriptions remain a human confirmation step; Terraform must not
pretend an unconfirmed subscription is a working alert channel. The us-east-2
`kortix-compliance-alerts` subscription is declared in Terraform because Drata
DCF-86 requires the alarm topic to hold a subscription, and it reads
PendingConfirmation until the SNS confirmation email is clicked. The us-west-2
and eu-west-2 topics carry confirmed email subscriptions managed outside
Terraform.

Because Drata fails `hasSubscription` while the only subscription is pending,
the us-east-2 topic also carries a Lambda subscriber
(`compliance-alerts-logger.tf`) that is Active immediately on Subscribe and
logs every alert to `/aws/lambda/kortix-compliance-alerts-logger` in
CloudWatch Logs. The email subscription remains the human delivery channel.

## Verify EC2 CPU coverage

The reconciler only writes an alarm when it is absent or its metric, threshold,
period, instance dimension, or SNS action has drifted. Invoke both regional
functions and compare every running instance ID with the alarm dimensions:

```bash
aws lambda invoke --region us-west-2 \
  --function-name kortix-ec2-cpu-alarm-reconciler /tmp/usw2.json
aws lambda invoke --region eu-west-2 \
  --function-name kortix-ec2-cpu-alarm-reconciler /tmp/euw2.json
```

Both payloads must report `covered_instances == running_instances` and an empty
`updated_instances` list on the second invocation.

## Verify ALB alarm coverage

Invoke the reconciler twice in each production-system region. The second
invocation must report `covered_alarms == elb-5xx and target-response-time per
ALB + unhealthy-hosts and zero-healthy-hosts per target group`, an empty
`updated_alarms` list, and an empty `deleted_alarms` list.

```bash
for region in us-west-2 eu-west-2 us-east-2; do
  aws lambda invoke --region "$region" \
    --function-name kortix-alb-alarm-reconciler \
    "/tmp/${region}-alb-reconciler.json"
done
```

## Verify us-east-2 controls

The us-east-2 network ACL excludes inbound TCP ports `22` and `3389`. The
default network ACL and default security group contain no allow rules.

```bash
aws wafv2 list-resources-for-web-acl --region us-east-2 \
  --web-acl-arn "$(aws wafv2 list-web-acls --region us-east-2 \
    --scope REGIONAL --query 'WebACLs[?Name==`kortix-alb-waf`].ARN|[0]' \
    --output text)" --resource-type APPLICATION_LOAD_BALANCER

aws cloudwatch describe-alarms --region us-east-2 \
  --alarm-name-prefix kortix-alb-

aws ec2 describe-flow-logs --region us-east-2 \
  --filter Name=resource-id,Values=vpc-03371e6a60dafbd25
```

## Drata test decisions

A disabled Drata test needs a recorded reason. The public API disables a test
with `PUT /public/v2/workspaces/{ws}/monitoring-tests/{testId}` and body
`{"enabled": false}`, and records only "Disabled via Public API". This table
is the record.

| Test | Decision | Date | Rationale |
| --- | --- | --- | --- |
| `225` Hardware MFA for AWS Root Account | Disabled, risk accepted by the account owner | 2026-09-29 | SOC 2 does not require hardware MFA; the test comes from the CIS AWS Foundations Benchmark. Control `DCF-90` (root account monitored) is met by test `214` (root has MFA), test `124` (root unused), no root access keys, and a page on every successful root console sign-in (`../security-baseline/root-account-alerting.tf`: EventBridge rule `kortix-root-login-failures`, us-east-1 to us-west-2, SNS `suna-api-alerts`, confirmed email subscriber). Re-evaluate at the annual policy review. |
| `300` AWS Lambda Error Rate Monitored | Re-enabled | 2026-09-29 | Every Lambda in the account has an `Errors` alarm (`reconciler-health.tf`). |

## Drata IaC scan: how it reads this tree

The `drata-compliance.yml` scan uploads every `.tf` file and returns findings
per resource. Four parser rules explain every finding it reports:

1. It merges resources that share a type and name across roots. Two roots that
   both declare `aws_s3_bucket.alb_logs` become one resource with mixed
   attributes. Give every resource a name that is unique in `infra/terraform`.
2. It does not resolve `local.tags`, `var.tags`, `merge()` or `lookup()` on
   KMS, S3, SNS, IAM role, EC2, subnet and DynamoDB resources (test `8028`).
   Root-level resources repeat the tag map as a literal.
3. It does not resolve module variables, so `subnets = var.public_subnet_ids`
   reads as empty (test `8004`).
4. It caches results by branch and commit SHA. Re-running a scan for the same
   SHA returns the first result.

Reproduce a scan without a push: run `drata/compliance-as-code-action`'s
`dist/index.js` with `GITHUB_WORKSPACE` set to a directory that holds
`infra/`, a unique `GITHUB_REF_NAME` and `GITHUB_SHA`, and
`DRATA_API_TOKEN` from `kortix-ci-env:DRATA_IAC_PIPELINE_KEY`. Read the result
from `GET https://public-api.drata.com/public/workspaces/1/pipelines/results?runId=<id>&branchName=<ref>`.

## Drata IaC exclusions

Each row is a finding that is correct by design or that the parser cannot
read. Create one Drata exclusion per row (Drata → Monitoring → Pipeline →
finding → Exclude), with the rationale below. Exclusions are keyed by finding
ID; re-create a row if Drata renames its ID scheme.

| Sev | Test | Resource | Rationale |
| --- | --- | --- | --- |
| Critical | 8025 | `security-baseline` `aws_iam_role_policy.gha_nacl_audit` | Grants only `ec2:DescribeRegions` and `ec2:DescribeNetworkAcls`. AWS supports no resource-level permission for either action, so `Resource` must be `*`. The audit scans every enabled region, so a region condition would defeat it. Read-only. OIDC trust pinned to `main`. |
| High | 8011 | `modules/ecs-api` `aws_lb.this` (`internal`) | The public `api.kortix.com` origin. It must accept internet traffic. The security group admits only `var.alb_ingress_cidrs` (Cloudflare); WAF, TLS 1.3 and access logs protect it. |
| Moderate | 8004 | `modules/ecs-api` `aws_lb.this` (`subnets`, `subnet_mapping`) | Receives two subnets in two availability zones from `modules/network`; AWS rejects fewer. Parser rule 3. |
| Moderate | 8007 | 6 `aws_lambda_function`: 5 compliance reconcilers and the alerts logger | They call public AWS control-plane APIs only. A VPC adds a NAT or endpoint dependency to the functions that repair and report controls. No data plane access. |
| Moderate | 8010 | `modules/selfhost-ec2` `aws_security_group.this` egress | Self-host boxes reach registries, model providers and user-chosen hosts with no stable CIDR. Ingress is restricted separately. |
| Moderate | 8028 | `modules/network` `aws_subnet.public`, `aws_subnet.private` | Tagged with `lookup(var.tags, …)` and an interpolated Kubernetes key. Parser rule 2. |
| Moderate | 8028 | `compliance-monitoring` `aws_network_acl_association.use2_restricted` | An association to subnets read by a data source; Terraform does not own those subnets' tags. |
| Moderate | 8028 | `modules/ecs-api` `aws_kms_key.logs`, `aws_s3_bucket.alb_logs`; `modules/selfhost-ec2` `aws_instance.this`, `aws_kms_key.alarm_topic`; `modules/project-snapshots-bucket` `aws_s3_bucket.this` | Module resources take the caller's `var.tags`; a literal map would drop per-environment tags. Parser rule 2. |
