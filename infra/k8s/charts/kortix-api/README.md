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

Kortix Cloud keeps migrations in the GitHub Actions `migrate-db` jobs before its
GitOps rollout. The chart's hook is disabled by default there. Enterprise VPC
installations enable the hook because their customer-owned updater has no Kortix
CI database credentials; it runs the same canonical
`bun scripts/migrate.ts up` node-pg-migrate ledger from the digest-pinned API
image before Helm rolls the application.
