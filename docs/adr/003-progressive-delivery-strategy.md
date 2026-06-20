# ADR-003: Progressive Delivery Strategy (Argo Rollouts Canary)

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** Platform Engineering

## Context

Production deploys must be safe to roll forward and trivially reversible. The
GitOps flow (ADR-001) already makes rollback a `git revert`, but a bad image can
still serve errors to real users for the duration of a full rolling update before
anyone reverts. We want metric-gated progressive delivery that shifts traffic
gradually and **auto-rolls-back on objective signals** (5xx rate, latency)
without a human watching.

The important fact about this repo: progressive delivery is **already built**.
The `kortix-api` chart ships:

- `infra/k8s/charts/kortix-api/templates/rollout.yaml` — an Argo Rollouts
  `Rollout` that replaces the `Deployment` when `rollout.enabled: true`, sharing
  the same pod spec via `_pod.tpl` (identical probes, drain, spread, secrets),
  shifting weight through `rollout.steps`.
- `infra/k8s/charts/kortix-api/templates/analysistemplate.yaml` — an
  `AnalysisTemplate` that queries **CloudWatch** every minute for the ALB 5xx
  error-rate and p95 `TargetResponseTime` over the target group, with
  `failureLimit: 2` (two consecutive breaches abort and roll back to stable).
  Each metric is guarded by a `min-requests` threshold so a low-traffic
  environment cannot false-abort on a single transient 5xx.

Both are currently **disabled**. `infra/k8s/envs/prod/values.yaml` sets
`rollout.enabled: false` (plain rolling Deployment) and
`rollout.analysis.enabled: false`, because during the ECS→EKS dual-run
`api-eks.kortix.com` carries almost no traffic, and metric-based canary analysis
is unreliable without volume — both error-rate and cold-start p95 latency
false-abort on noise. The live ALB/target-group dimensions are already
pre-populated (`lbArnSuffix`, `tgArnSuffix`) and ready.

Argo Rollouts itself is installed by the platform Terraform
(`modules/eks/platform`), and the controller reads CloudWatch via its IRSA role.

## Decision

Standardise on **Argo Rollouts canary with CloudWatch analysis** as the
production progressive-delivery mechanism. **The decision is to enable the
existing implementation post-cutover, not to build anything new.**

Specifically:

- Keep `rollout.enabled: false` while ECS and EKS dual-run. During this window
  safety comes from pod health — a bad image whose pods never become Ready holds
  the rollout regardless of traffic.
- At the `api.kortix.com` cutover (when `ACTIVE_BACKEND` flips to `eks` and real
  traffic lands on EKS), set `rollout.enabled: true` and
  `rollout.analysis.enabled: true` in `envs/prod/values.yaml`. The canary then
  steps 10→25→50→100% with a background `AnalysisRun` auto-rolling-back on 5xx or
  p95 breach.
- Watch a canary with
  `kubectl argo rollouts get rollout kortix-api -n kortix-prod --watch`.
- Instant escape hatch: `rollout.enabled: false` reverts to a plain Deployment in
  one line.

## Consequences

**Positive**

- Production releases shift traffic gradually with objective, automated
  auto-rollback — no human babysitting a deploy.
- Zero net-new code: the templates, IRSA, and ALB dimensions already exist;
  enabling is a values flip.
- The `min-requests` guard means the same template is safe in low-traffic envs.
- Fully reversible (`rollout.enabled: false`) and GitOps-tracked.

**Negative**

- Canary analysis is only meaningful with sustained traffic — hence it stays off
  until cutover, leaving a window where prod uses plain rolling updates.
- CloudWatch's ~1-minute metric resolution bounds how fast a regression is
  detected; very short error spikes may pass.
- Adds Argo Rollouts as a dependency in the deploy path (already installed and
  exercised on low-traffic api-eks).

## Alternatives Considered

- **Plain rolling Deployment only.** Simple and currently in use, but gives no
  metric gate — a bad release rolls fully out and serves errors until someone
  reverts.
- **Flagger.** Comparable canary capability, but pulls in a second progressive-
  delivery controller when Argo Rollouts already integrates natively with our
  Argo CD GitOps stack and is already installed and templated in the chart.
- **Blue/green.** Cleaner instant cutover but doubles steady-state capacity and
  offers no gradual traffic exposure; canary better fits an autoscaled API.
