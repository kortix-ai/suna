# compliance-monitoring

Regional, discovery-based SOC 2 monitoring for the Kortix AWS account. This
stack has its own state so it cannot accidentally adopt or mutate the legacy
`security-baseline` stack.

It manages:

- WAF association for every current ALB in us-west-2 and eu-west-2.
- Target response time, ELB 5xx, and unhealthy-host CloudWatch alarms for every
  current ALB, with regional SNS actions (Drata DCF-86 / DCF-88).
- CPU-utilization CloudWatch alarms for every running EC2 instance in the dev
  and production regions, discovered on every plan so replacement EKS workers
  remain covered (Drata DCF-86).
- Regional Lambda reconcilers triggered by EC2 running-state events, plus a
  five-minute repair schedule, so replacement instances receive the same alarm
  without waiting for another Terraform apply.
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
