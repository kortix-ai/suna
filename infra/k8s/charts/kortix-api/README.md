# kortix-api Helm chart

The Kortix API workload on EKS. Deployed by `.github/workflows/deploy-prod-eks.yml`
(and for first bring-up, by hand — see `infra/EKS.md`). Terraform owns the
cluster + controllers; this chart owns the app, mirroring how CI rolls the ECS
service while Terraform owns the ECS infra.

## What it renders

| Object | Purpose |
| ------ | ------- |
| `Deployment` | The API. Startup/liveness/readiness probes, `preStop` drain, 3-AZ `topologySpreadConstraints`, `maxUnavailable: 0` rolling deploys. |
| `Service` (ClusterIP) | Backend for the ALB target group. |
| `Ingress` (`alb`) | AWS Load Balancer Controller → internet-facing ALB, ACM TLS, `:80→:443`, IP targets, `/v1/health` checks. external-dns → proxied `api-eks.kortix.com`. |
| `HorizontalPodAutoscaler` | CPU+memory target tracking, 3→12 replicas. |
| `PodDisruptionBudget` | `minAvailable: 50%` — disruptions never drop below half. |
| `ServiceAccount` | Annotated with the IRSA role (Secrets Manager read). |
| `SecretStore` + `ExternalSecret` | Sync the shared `kortix-prod-env-omifd2` bundle → `kortix-api-env`, consumed via `envFrom`. |

## Required deploy-time values

These come from `terraform -chdir=environments/prod-eks/cluster output`:

| Value | From TF output |
| ----- | -------------- |
| `serviceAccount.roleArn` | `app_irsa_role_arn` |
| `ingress.certificateArn` | `acm_certificate_arn` |
| `image.tag` | the released version (e.g. `0.9.36`) |
| `kortixVersion` | same version string (reported by `/v1/health`) |

The chart `fail`s fast if `serviceAccount.roleArn` or `ingress.certificateArn`
are unset, so a misconfigured deploy never reaches the cluster.
