# qa-portal Helm chart

The internal QA report portal at **qa.kortix.com**: a small, **stateless** pod
that serves the generated **Allure** static reports **straight from the private
S3 bucket** — it stores no report bytes locally. Deployed by Argo CD
(`infra/k8s/argocd/applications/qa.yaml`) into the `kortix-qa` namespace.
Terraform (`modules/qa-portal`) owns the S3 bucket + IRSA role; this chart owns
the workload.

## What it renders

| Object | Purpose |
| ------ | ------- |
| `Deployment` | `web` (nginx) serves the branded landing page at `/` from a small generated file and reverse-proxies every other path to `s3gw`; `s3gw` (`nginx-s3-gateway`, stock) signs each request (SigV4) and streams the object from the **private** bucket; `index-gen` (aws-cli, **read-only**) relists the `reports/` lanes every `syncIntervalSeconds` and rebuilds the kilobyte landing `index.html`. Only that landing file is local. |
| `Service` (ClusterIP) | Backend for the ALB target group (port 80 → web `8081`). |
| `Ingress` (`alb`) | AWS Load Balancer Controller → internet-facing ALB, ACM TLS, `:80→:443`, IP targets. external-dns → proxied `qa.kortix.com`. |
| `ServiceAccount` | Annotated with the IRSA role (S3 read) — **no static AWS keys**. |

## Durability model

Results + reports live in **versioned S3** (`modules/qa-portal`); the pod holds
nothing and streams each object on demand, so a restart loses nothing and the
pod can never outgrow a local volume (the old `aws s3 sync`-into-`emptyDir`
design grew past its `1Gi` limit and crash-looped). The landing page lists
whatever lanes currently exist in S3; if nothing is published yet it just shows
empty sections.

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
