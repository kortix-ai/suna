# Production `us-east-2` shadow stack

This Terraform root creates the parallel production API and gateway in
`us-east-2`.

It uses separate Terraform state:

`prod-us-east-2-shadow/ecs-api.tfstate`

The state bucket is `kortix-terraform-state-us-east-2-935064898258`.
The lock table is `kortix-terraform-locks-us-east-2`.
Both backend resources are in `us-east-2`.
Both resources use customer-managed KMS encryption.
State versioning is enabled with 365-day noncurrent-version retention.

It does not create or change DNS records.

The pre-cutover shadow records exist outside this Terraform state:

- `api-use2-shadow.kortix.com`
- `gateway-use2-shadow.kortix.com`

The records route only the shadow verification hosts. They do not change
`api.kortix.com`, `gateway.kortix.com`, or production traffic.

The ALBs accept traffic only from the Cloudflare IPv4 ranges in
`alb_ingress_cidrs`. The release workflow keeps both shadow CNAME records
proxied.

The task secret is `kortix-prod-us-east-2-env`.
Its worker, scheduler, channel, tunnel, warm-pool, and managed-provider flags
remain disabled until the final production cutover.

Production releases call
`.github/workflows/deploy-prod-us-east-2-shadow.yml`. That workflow applies
target migrations, refreshes application replication, and registers new ECS
task definitions. The ECS module ignores service task-definition drift because
the release workflow owns task revisions.

Apply with the exact current secret key set:

```bash
secret_json="$(
  aws secretsmanager get-secret-value \
    --secret-id kortix-prod-us-east-2-env \
    --region us-east-2 \
    --query SecretString \
    --output text
)"

export TF_VAR_secret_arn="$(
  aws secretsmanager describe-secret \
    --secret-id kortix-prod-us-east-2-env \
    --region us-east-2 \
    --query ARN \
    --output text
)"
export TF_VAR_secret_keys="$(jq -c 'keys' <<<"$secret_json")"
terraform init
terraform plan -out=shadow.tfplan
terraform apply shadow.tfplan
```
