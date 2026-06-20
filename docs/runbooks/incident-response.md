# Runbook: Incident Response

How we respond when prod (`api.kortix.com` → `kortix-prod-eks`, eu-west-2) or dev
(`dev-api.kortix.com` → `kortix-dev-eks`, us-west-2) misbehaves. The
observability and ops surfaces are the **Headlamp DevOps console** (pods, events,
live logs across clusters) and **Grafana** (metrics + Loki logs), both reached
behind the SSO-gated `devops.<domain>` console (e.g. `devops.kortix.com`; Argo CD
itself is at `ops.kortix.com`).

---

## Severity levels

| Sev | Definition | Examples | Response |
|---|---|---|---|
| **SEV1** | Prod down / data-loss risk / security breach. Customer-facing outage. | `api.kortix.com` 5xx storm; all `kortix-prod` pods CrashLooping; Supabase unreachable; secret leak. | Page immediately. All-hands. Roll back first, diagnose later. |
| **SEV2** | Major degradation, prod still partially up. | Elevated p95 latency / partial 5xx; HPA pinned at `maxReplicas: 12`; one AZ's pods down; ESO not syncing. | Respond in business hours w/ urgency; on-call drives. |
| **SEV3** | Minor / no customer impact; dev-only. | `kortix-dev` flapping; a preview env (`kortix-pr-*`) broken; noisy non-paging alert. | Normal queue; fix in working hours. |

> **Alerting status — planned.** Automated paging is **not yet wired**:
> Alertmanager is disabled and there are 0 alerting rules
> (`infra/INFRASTRUCTURE_PLAN.md`, Wave 4 ships PrometheusRule SLO burn-rate
> alerts → Alertmanager → Slack(warn)/PagerDuty(crit)). Until then, incidents are
> detected by humans (Grafana dashboards, customer reports, the deploy-watch
> failing in `deploy-prod.yml`). Treat any prod `/v1/health` failure as SEV1.

---

## First 5 minutes

1. **Declare + timestamp.** Open an incident channel (e.g. Slack
   `#inc-<date>-<short>`), state the suspected severity, and assign an **Incident
   Commander (IC)**. One person drives; everyone else feeds the IC.
2. **Confirm scope** — is it real and prod?
   ```bash
   curl -fsS -o /dev/null -w '%{http_code}\n' https://api-eks.kortix.com/v1/health
   curl -fsS https://api-eks.kortix.com/v1/health | jq '{version,status}'
   aws eks update-kubeconfig --name kortix-prod-eks --region eu-west-2
   kubectl -n kortix-prod get pods -o wide
   kubectl -n kortix-prod rollout status deploy/kortix-api --timeout=20s
   ```
3. **Did a deploy just happen?** Most incidents follow a release.
   ```bash
   git log --oneline -5 -- infra/k8s/envs/prod/values.yaml   # last image.tag bumps
   argocd app history kortix-prod                             # recent synced revisions
   ```
   If yes → **roll back now** (`docs/runbooks/rollback-procedure.md`). Recover
   first; root-cause after.
4. **Check the obvious blast radius**: pods Ready? ESO syncing? Ingress/ALB up?
   ```bash
   kubectl -n kortix-prod get deploy,hpa,pdb
   kubectl -n kortix-prod get externalsecret   # SecretSynced=True when healthy
   kubectl -n kortix-prod get ingress          # ADDRESS = the ALB hostname
   kubectl -n kortix-prod get events --sort-by=.lastTimestamp | tail -20
   ```
5. **Communicate** — post the initial status (template below) so stakeholders
   stop asking and you can work.

---

## Triage

### Headlamp console (pods, events, live logs)

`devops.<domain>` → Headlamp (`kortix-platform-console` Argo app; one console
spans every cluster/context via the `headlamp-kubeconfig` secret). Use it for:

- Pod status, restart counts, last termination reason (e.g. **OOMKilled / exit
  137** — the prod pod sits ~840Mi; memory is pinned to `2Gi` request==limit
  Guaranteed QoS in `infra/k8s/envs/prod/values.yaml`).
- Live per-pod logs and the resource event stream.

CLI equivalents:

```bash
kubectl -n kortix-prod logs -l app.kubernetes.io/name=kortix-api -f --tail=200
kubectl -n kortix-prod describe pod <pod>          # Events, last state, OOMKilled?
kubectl -n kortix-prod top pods                     # live CPU/mem vs limits
kubectl -n kortix-prod get hpa kortix-api -w        # pinned at maxReplicas 12?
```

### Grafana (metrics + Loki logs)

`devops.<domain>/grafana` (`kortix-platform-metrics` =
kube-prometheus-stack: Prometheus + Grafana, ns `monitoring`; Loki via
`kortix-platform-logs` = loki-stack, queried as a Grafana datasource). Use for:

- **Golden signals** — request rate, error rate (5xx), p95/p99 latency,
  saturation (CPU/mem vs limits). Confirms severity and whether a rollback fixed
  it.
- **Loki** — search structured logs *across* namespaces/pods (what per-pod
  Headlamp logs can't do), e.g. `{namespace="kortix-prod"} |= "error"` or filter
  by request ID.

### Common failure classes → first move

| Symptom | Likely cause | First move |
|---|---|---|
| Pods CrashLoop right after a deploy | Bad image / config | **Roll back** (Path 1/2) |
| `OOMKilled` (exit 137), random restarts | Memory ceiling | Check `top pods`; raise `resources` in env values (already `2Gi` prod) |
| Pods Ready but 5xx | App/DB error, Supabase, secrets | Loki errors; `get externalsecret`; check Supabase status |
| `ExternalSecret` not `SecretSynced` | ESO / Secrets Manager / IRSA | `docs/runbooks/secret-rotation.md`; check IRSA role |
| HPA stuck at max, latency high | Real load / node pressure | `docs/runbooks/scaling-procedure.md`; check cluster-autoscaler |
| Ingress has no ADDRESS | ALB controller / cert | Check `aws-load-balancer-controller`, ACM cert in env values |

---

## Escalation path

1. **On-call engineer** — first responder; runs the first-5-minutes + triage.
2. **Incident Commander** — coordinates if it's SEV1/SEV2 (may be the same
   person on a small team; hand off if you're hands-on fixing).
3. **Platform/Infra owner** — for cluster, Terraform, networking, IRSA.
4. **External**: Supabase support (external DB), AWS Support (EKS control plane /
   ALB), Cloudflare (Worker `api-kortix-router` / edge). For a backend-origin
   incident, the **fastest mitigation is the Cloudflare Worker switch**: flip
   `ACTIVE_BACKEND` away from `eks` (to `ecs-fargate`) — sub-second, reversible
   (`infra/CICD.md`).

> **PagerDuty is not yet provisioned** (catalogued in `docs/WHATS_MISSING.md`).
> Escalate manually via Slack/phone until the PagerDuty account + Alertmanager
> routing land (Wave 4).

---

## Comms template

```
🔴 [SEV{1|2|3}] {one-line symptom} — {INVESTIGATING|IDENTIFIED|MONITORING|RESOLVED}
Time (UTC):  {timestamp}
Impact:      {who/what is affected — e.g. api.kortix.com returning 5xx, ~X% of requests}
Scope:       prod (kortix-prod-eks / eu-west-2)   [or dev]
IC:          @{name}
Current:     {what we know / what we're doing}
Mitigation:  {rollback in progress / Worker flipped to ecs-fargate / N/A}
Next update: {time, e.g. in 15 min}
```

Cadence: SEV1 every 15 min, SEV2 every 30–60 min, until **RESOLVED**.

---

## Post-incident

Within 48h of any SEV1/SEV2, write a blameless post-incident review:

- **Timeline** (UTC): detection → triage → mitigation → resolution.
- **Impact**: duration, requests/users affected, data integrity.
- **Root cause** (and contributing factors).
- **What worked / what slowed us down** (e.g. manual detection — no Alertmanager
  yet).
- **Action items** with owners + due dates; feed gaps into
  `docs/WHATS_MISSING.md`.
- **DORA**: record the failure for change-failure-rate and the
  detection→resolved time for MTTR (the DORA dashboard sourced from Alertmanager
  + GitHub deploy events is a Wave 4 deliverable —
  `infra/INFRASTRUCTURE_PLAN.md`).
