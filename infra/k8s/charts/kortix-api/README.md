# kortix-api Helm chart

The Kortix API workload on EKS. Dev is deployed by `.github/workflows/deploy-dev.yml`
through a GitOps values bump on `main`; prod is deployed by `.github/workflows/deploy-prod.yml`
after a reviewed promote PR lands on `prod`. Terraform owns the clusters and
controllers; this chart owns the application objects that Argo CD reconciles.

## What it renders

| Object | Purpose |
| ------ | ------- |
| `Deployment` | The API. Startup/liveness/readiness probes, `preStop` drain, 3-AZ `topologySpreadConstraints`, `maxUnavailable: 0` rolling deploys. |
| `Service` (ClusterIP) | Backend for the ALB target group. |
| `Ingress` (`alb`) | AWS Load Balancer Controller → internet-facing ALB, ACM TLS, `:80→:443`, IP targets, `/v1/health` checks. external-dns → proxied `api-eks.kortix.com`. |
| `HorizontalPodAutoscaler` | CPU+memory target tracking, 3→12 replicas. |
| `PodDisruptionBudget` | `minAvailable: 50%` — disruptions never drop below half. |
| `ServiceAccount` | Annotated with the IRSA role (Secrets Manager read). |
| `SecretStore` + `ExternalSecret` | Sync the per-env AWS Secrets Manager bundle → `kortix-api-env`, consumed via `envFrom`. |

## Required deploy-time values

These come from the corresponding EKS Terraform environment outputs and the
GitOps value files under `infra/k8s/envs/<env>/`:

| Value | From TF output |
| ----- | -------------- |
| `serviceAccount.roleArn` | `app_irsa_role_arn` |
| `ingress.certificateArn` | `acm_certificate_arn` |
| `image.tag` | the released version (e.g. `0.9.36`) |
| `kortixVersion` | same version string (reported by `/v1/health`) |

The chart `fail`s fast if `serviceAccount.roleArn` or `ingress.certificateArn`
are unset, so a misconfigured deploy never reaches the cluster.

Database migrations are **not** applied by this chart in the current live deploy
path. The GitHub Actions `migrate-db` jobs run `pnpm --filter @kortix/db migrate`
(node-pg-migrate) before the GitOps rollout. The chart still contains a disabled
legacy PreSync hook; do not enable it until it is ported or removed
(https://github.com/kortix-ai/suna/issues/3628).
