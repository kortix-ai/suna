# qa-portal Helm chart

The internal QA report portal at **qa.kortix.com**: a small, stateless nginx pod
that serves the latest generated **Allure** static report, kept in sync from S3.
Deployed by Argo CD (`infra/k8s/argocd/applications/qa.yaml`) into the
`kortix-qa` namespace. Terraform (`modules/qa-portal`) owns the S3 bucket + IRSA
role; this chart owns the workload.

## What it renders

| Object | Purpose |
| ------ | ------- |
| `Deployment` | `initContainer` (aws-cli) primes the report before serving; `nginx` serves `/usr/share/nginx/html`; a `report-sync` sidecar re-runs `aws s3 sync` every `syncIntervalSeconds`. All three share an `emptyDir`. |
| `Service` (ClusterIP) | Backend for the ALB target group (port 80 → nginx 8080). |
| `Ingress` (`alb`) | AWS Load Balancer Controller → internet-facing ALB, ACM TLS, `:80→:443`, IP targets. external-dns → proxied `qa.kortix.com`. |
| `ServiceAccount` | Annotated with the IRSA role (S3 read) — **no static AWS keys**. |

## Durability model

Results + reports live in **versioned S3** (`modules/qa-portal`); the pod is a
disposable cache. A pod restart re-syncs from `reports/latest/` and loses
nothing. If no report has been published yet, the initContainer drops a
placeholder so the pod is still healthy.

## Required deploy-time values

From `terraform -chdir=<cluster-or-qa-portal layer> output`:

| Value | From TF output |
| ----- | -------------- |
| `bucket` | `bucket_name` |
| `serviceAccount.roleArn` | `role_arn` |
| `ingress.certificateArn` | the ACM cert ARN for `qa.kortix.com` |

The chart `fail`s fast if `bucket`, `serviceAccount.roleArn`, or
`ingress.certificateArn` are unset, so a misconfigured deploy never reaches the
cluster.

See **RUNBOOK.md** for the exact apply order and every cluster-specific value to
confirm.
