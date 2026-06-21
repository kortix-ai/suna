# ADR-002: Kyverno over OPA/Gatekeeper for Admission Control

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** Platform Engineering

## Context

The maturity scorecard in `docs/INFRASTRUCTURE_PLAN.md` flags admission control
as a primary gap: today there is no policy gate enforcing least-privilege pod
specs, registry allow-lists, digest pinning, or per-namespace network/PDB
defaults on either cluster. An enterprise security review will expect a
Kubernetes admission controller as a hard guardrail behind PodSecurityAdmission.

We need a tool that can both **validate** (reject non-conformant resources) and
**fill gaps proactively** — auto-creating a default-deny `NetworkPolicy` and a
`PodDisruptionBudget` for every new namespace, and mutating pods to inject a
hardened `securityContext`. Critically, this is operated by a small platform
team, so review and operational burden matter as much as raw capability.

The two mainstream choices are **Kyverno** and **OPA/Gatekeeper**.

## Decision

Adopt **Kyverno** as the admission and policy engine on both clusters, delivered
as a GitOps-managed Argo `Application` (project `platform`) sourced from
`infra/policies/kyverno/`.

Rationale specific to this platform:

- **Policies are Kubernetes-native YAML — no Rego.** Gatekeeper requires
  ConstraintTemplates written in Rego plus a separate Constraint CRD per policy.
  Kyverno policies are plain YAML that reads like the Kubernetes objects they
  govern, so the whole platform team can author and review them.
- **`generate` closes gaps no validator can.** One Kyverno `generate` rule
  auto-creates a default-deny `NetworkPolicy` and a `PodDisruptionBudget` in
  every namespace as it appears — directly hardening the dynamically created
  `kortix-pr-*` preview namespaces from `applicationsets/preview.yaml` without a
  human in the loop.
- **`mutate` injects the hardened defaults.** A `mutate` rule stamps
  `runAsNonRoot`, `allowPrivilegeEscalation: false`,
  `seccompProfile: RuntimeDefault`, and `capabilities.drop: [ALL]` onto pods,
  complementing the chart's own `_pod.tpl` securityContext and catching anything
  deployed outside the chart.
- **`validate` enforces supply-chain hygiene** — disallow `:latest`, require an
  image digest, require resource limits, restrict registries to our own, and
  require `team`/`env` labels.

A single tool thus closes three distinct gaps (securityContext injection,
per-namespace NetworkPolicy/PDB, image/registry policy), which is decisive for a
small team.

**Rollout is audit-first.** All policies ship with
`validationFailureAction: Audit` so violations are reported for a soak period
(target: one clean week) with zero blocked deploys. We then flip to `Enforce`
per-namespace, starting on dev/preview and graduating to `kortix-prod` last —
matching the audit-before-enforce, dev-first discipline used everywhere in this
migration.

## Consequences

**Positive**

- One YAML-native tool covers validation, mutation, and generation; no Rego
  skill required to review a policy PR.
- `generate` keeps the ephemeral preview namespaces hardened automatically.
- Audit mode makes the security uplift non-breaking; Enforce is a per-namespace,
  reversible flip.
- Policy is GitOps-managed and self-healed by Argo CD like everything else.

**Negative**

- Kyverno's admission webhook is in the request path; it must run HA and be
  monitored, or a webhook outage can stall deploys (mitigated by `Audit`
  defaults and `failurePolicy` tuning).
- Complex cross-resource logic is less expressive than Rego, so a rare policy
  may need a JMESPath workaround.
- Another in-cluster controller to patch and keep current on both clusters.

## Alternatives Considered

- **OPA/Gatekeeper.** Powerful and CNCF-graduated, but Rego raises the authoring
  and review bar for a small team, and its mutation/generation capabilities are
  weaker and less mature than Kyverno's `mutate`/`generate` — which are the exact
  features that let us close multiple gaps with one tool.
- **PodSecurityAdmission alone.** Kept as a complementary baseline (namespaces
  labeled `restricted`), but PSA only validates the built-in Pod Security
  Standards — it cannot enforce registry allow-lists or digest pins, and it
  cannot generate NetworkPolicies or PDBs. Insufficient on its own.
