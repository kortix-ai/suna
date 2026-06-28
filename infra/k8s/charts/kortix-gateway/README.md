# kortix-gateway Helm chart

The standalone Kortix LLM gateway workload on EKS. It runs alongside
`kortix-api` in the same namespace, reusing the API ServiceAccount and the
already-synced `kortix-api-env` secret bundle. Dev is reconciled from `main` via
`infra/k8s/argocd/applications/gateway-dev.yaml`; prod is reconciled from `prod`
via `gateway-prod.yaml`.

## What it renders

| Object | Purpose |
| ------ | ------- |
| `Deployment` | Gateway process on port `8090`; streaming-safe termination (`preStop` + 300s grace). |
| `Service` (ClusterIP) | Backend for the ALB target group and in-cluster callers. |
| `Ingress` (`alb`) | Public gateway host (`gateway-dev.kortix.com` / `gateway.kortix.com`) with long idle timeout for LLM streams. |
| `HorizontalPodAutoscaler` | Memory/CPU target tracking for long-lived stream load. |
| `PodDisruptionBudget` | Keeps at least half the replicas available during disruptions. |

## Required deploy-time values

Per-environment values live in `infra/k8s/envs/<env>/gateway-values.yaml`:

| Value | Purpose |
| ----- | ------- |
| `image.tag` | Gateway image tag deployed by GitOps. |
| `ingress.host` | Public gateway hostname. |
| `ingress.certificateArn` | ACM certificate for the gateway ALB. |

The chart intentionally has no ServiceAccount or ExternalSecret of its own; it
depends on the API chart having created `kortix-api` and `kortix-api-env` first,
and Argo CD retries until those dependencies exist.
