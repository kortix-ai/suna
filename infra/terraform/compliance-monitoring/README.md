# compliance-monitoring

Regional, discovery-based SOC 2 monitoring for the Kortix AWS account. This
stack has its own state so it cannot accidentally adopt or mutate the legacy
`security-baseline` stack.

It manages:

- WAF association for every current ALB in us-west-2 and eu-west-2.
- Target response time, ELB 5xx, and unhealthy-host CloudWatch alarms for every
  current ALB, with regional SNS actions (Drata DCF-86 / DCF-88).
- Least-privilege SNS topic policies for EventBridge and CloudWatch delivery.
- AWS Backup and EBS snapshot failure EventBridge rules and SNS targets
  (Drata DCF-99).

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
pretend an unconfirmed subscription is a working alert channel.
