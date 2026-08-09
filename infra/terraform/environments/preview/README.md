# ECS PR preview runtime

This root provisions the persistent, non-production control plane for ephemeral
PR API previews. It reuses the dev VPC and NAT gateway. It does not change the
dev ECS services or any production resource.

The shared resources are:

- one ECS cluster (`kortix-preview`);
- one HTTPS ALB with the existing `*.preview-api.kortix.com` ACM certificate;
- one DNS-only wildcard CNAME (`*.preview-api.kortix.com`) to the ALB;
- one WAF association, encrypted ALB access logs, and encrypted task logs;
- one task execution role that can read only `kortix-preview-env`;
- one GitHub OIDC role scoped to per-PR resources in the preview cluster.

`deploy-preview.yml` creates one Fargate Spot service, task definition, target
group, and host listener rule per labeled PR. The API and gateway run as two
containers in the same task. The gateway has no public listener. The API reaches
it on `127.0.0.1:8090`.

The wildcard record is DNS-only. Cloudflare Universal SSL does not cover the
multi-level `pr-N.preview-api.kortix.com` hostname. TLS terminates at the ALB
with the existing ACM wildcard certificate. The WAF protects the direct edge.

## Bootstrap

This root must be applied once before the first ECS preview workflow can assume
its role. The bootstrap is intentionally outside this PR. Use a reviewed plan
and apply from an operator session:

```bash
terraform init
terraform plan -out=preview.tfplan
terraform apply preview.tfplan
```

The plan creates 26 shared non-production resources in account `935064898258`,
region `us-west-2`. It reads the existing dev VPC, `kortix-preview-env` secret,
GitHub OIDC provider, ACM certificate, and regional WAF. It must not target a
production VPC, secret, certificate, or DNS record.

Set `TF_VAR_cloudflare_api_token` only for this apply. Do not commit the token.
The workflow uses `pull_request_target` and executes lifecycle scripts only from
the default branch. This prevents a PR from changing code that runs with AWS or
Vercel credentials. It also means this PR cannot bootstrap its own live preview.
After this code reaches the default branch through an approved bootstrap, rerun
`Deploy Preview (PR)` on a labeled PR. A passing bootstrap requires all of the
following evidence:

1. `https://pr-<PR>.preview-api.kortix.com/v1/health` reports
   `environment=preview` and this PR's full commit SHA.
2. The sticky PR comment contains the Vercel deployment URL.
3. The Vercel deployment calls the per-PR backend successfully.
4. Closing or removing the label deletes the ECS service, listener rule, target
   group, active task definitions, and both branch-scoped Vercel variables.

The shared Terraform root remains after per-PR teardown.
