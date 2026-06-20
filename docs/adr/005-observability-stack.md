# ADR-005: Observability Stack

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** Platform Engineering

## Context

`docs/INFRASTRUCTURE_PLAN.md` scores observability as the lowest-maturity domain
(3 → 9). The platform already has a metrics and logs foundation but **no
alerting, no tracing, and no SLOs** — the cluster cannot page on a real problem,
and there is no request-level trace from ingress to service.

What is already deployed as GitOps Argo `Application`s (project `platform`,
single-source, config inline):

- **`kortix-platform-metrics`** — `kube-prometheus-stack` **86.3.2** from the
  prometheus-community repo: Prometheus (7d retention, remote-write receiver
  enabled to accept the dev-us cluster's metrics for a cross-region pane), Grafana
  (the single pane, persisted on gp2), and node / kube-state metrics.
  `alertmanager.enabled: false` today.
- **`kortix-platform-logs`** — `loki-stack` **2.10.3** from the Grafana repo:
  single-binary Loki on a gp2 PVC + Promtail tailing every pod, surfaced through
  the same Grafana via an auto-discovered Loki datasource.

So Grafana already unifies metrics + logs. The gaps are alerting, distributed
tracing, and codified SLOs.

## Decision

Standardise on **OpenTelemetry + Prometheus + Loki + Tempo + Grafana**, built as
**additions that extend the already-deployed `platform-metrics` and
`platform-logs` apps** rather than a replacement stack.

The additions:

- **Alertmanager.** Flip `alertmanager.enabled: true` in
  `platform-metrics.yaml` and route to Slack (warning) / PagerDuty (critical).
- **PrometheusRules.** Ship recording + alerting rules
  (`observability/alerts/*`) including multi-window, multi-burn-rate SLO alerts,
  each annotated with a runbook URL. ServiceMonitors from the chart (Wave 2)
  provide the scrape targets these rules depend on.
- **Tracing — Tempo + OpenTelemetry.** Add a Tempo Argo app and an OTel
  Collector DaemonSet (`observability/otel/*`) that receives app spans and exports
  to Tempo; Grafana links a metric exemplar to its trace for ingress→service
  drill-down.
- **SLOs.** Codify availability/latency SLOs (`observability/slos/*`) for the API
  and drive the burn-rate alerts above; add golden-signals, cluster, cost,
  security, and DORA dashboards.
- **Cross-region single pane.** The dev-us cluster remote-writes metrics and
  ships logs to the central (prod-eu) stack — the remote-write receiver is
  already enabled — so one Grafana covers both regions. Grafana lands behind SSO
  at `devops.<domain>/grafana` in the hosting phase.

## Consequences

**Positive**

- Builds on a proven, GitOps-managed base — alerting and tracing are additive
  Argo apps / values flips, not a re-platform.
- One Grafana pane for metrics, logs, and traces across both regions.
- Burn-rate SLO alerts with runbook links turn raw signals into actionable pages;
  a DORA dashboard makes delivery measurable.
- All open-source / CNCF; no per-host APM licensing.

**Negative**

- More stateful in-cluster components (Tempo, OTel Collector, Alertmanager) to
  run, size, and retain — storage and cardinality must be watched.
- Distributed tracing requires app-side OTel instrumentation to be genuinely
  useful, which is engineering work beyond deploying the collector.
- Self-hosted observability is operational surface the team owns end to end.

## Alternatives Considered

- **Datadog / New Relic (hosted APM).** Lowest operational burden but recurring
  per-host cost, vendor lock-in, and it discards the Prometheus/Loki/Grafana base
  already deployed and GitOps-managed here.
- **Grafana Cloud (managed LGTM).** Reduces ops load and is a natural future
  graduation, but for now self-hosting keeps data in-account and reuses the exact
  stack already running; the local Loki/Prometheus can graduate to managed/S3
  backends as a values change, not a re-architecture.
- **Jaeger for tracing.** Capable, but Tempo integrates more tightly with Grafana
  and the existing Prometheus/Loki datasources for exemplar-linked drill-down.
