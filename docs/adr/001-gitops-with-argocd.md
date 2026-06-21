# ADR-001: GitOps with Argo CD

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** Platform Engineering

## Context

The `suna-eks-migration` platform runs the Kortix API across two EKS clusters in
separate regions — `kortix-prod-eks` (eu-west-2) and `kortix-dev-eks`
(us-west-2) — plus ephemeral per-PR preview environments. We are retiring the
imperative ECS deploy path (`helm upgrade` / `aws ecs update-service` from
GitHub Actions) in favour of a declarative, auditable, self-healing reconcile
loop where the desired cluster state lives in git.

We needed a GitOps engine that could:

- Drive a single repo-of-truth (`infra/k8s/`) where bumping `image.tag` in
  `infra/k8s/envs/<env>/values.yaml` **is** the release, and `git revert` is the
  rollback.
- Generate ephemeral environments on demand — one API per open PR.
- Federate multiple clusters across regions from one control plane.
- Provide a mature admin UI we can expose, gated, as the `ops.kortix.com`
  console.

The two credible options are **Argo CD** and **Flux**.

## Decision

Adopt **Argo CD** as the single GitOps reconcile engine for both clusters.

Concretely, the design already standing in this repo:

- **App-of-apps.** `infra/k8s/argocd/app-of-apps.yaml` defines one parent
  `Application` (`kortix-apps`, project `kortix`) that recurses
  `infra/k8s/argocd/applications/` — adding an environment is adding one file,
  which Argo then self-manages.
- **AppProjects scope blast radius.** `project.yaml` (`kortix`) and
  `project-platform.yaml` (`platform`) whitelist the source repo and the exact
  destination namespaces (`kortix-prod`, `kortix-dev`, `kortix-staging`,
  `monitoring`, `kortix-platform`).
- **ApplicationSet PR generator powers previews.**
  `infra/k8s/argocd/applicationsets/preview.yaml` runs a `pullRequest` GitHub
  generator that watches `kortix-ai/suna` for open PRs labeled `preview`, renders
  the `kortix-api` chart at the PR head SHA into a `kortix-pr-<n>` namespace on
  `kortix-dev-eks`, and prunes the whole namespace when the PR closes.
- **Single-source Helm apps.** Every Application (app and `platform-*`) pins one
  source with `helm.values` inline rather than a multi-source `$values` overlay,
  deliberately avoiding the multi-source revision race.
- **Multi-cluster from one hub.** The prod-eu cluster reconciles locally
  (`https://kubernetes.default.svc`); dev-us and previews are registered remote
  destinations (`kortix-dev-eks`). The hub UI lands behind Cloudflare Access at
  `ops.kortix.com`.

Both clusters use `syncPolicy.automated` with `prune: true` and `selfHeal: true`,
so manual `kubectl edit` drift is auto-reverted.

## Consequences

**Positive**

- One declarative source of truth; deploy = commit, rollback = `git revert` or
  `argocd app rollback`.
- `selfHeal` continuously corrects drift across both clusters.
- The ApplicationSet PR generator gives true ephemeral previews for free — no
  bespoke controller to maintain.
- A mature web UI (and gRPC-Web CLI) backs the `ops.kortix.com` admin console and
  GitHub-org SSO.

**Negative**

- Argo CD is a heavier control plane than Flux (Redis, repo-server,
  application-controller) to run and patch.
- The hub is high-value and must be tightly gated (Cloudflare Access + ALB
  locked to Cloudflare IPs) or it becomes an attack surface.
- During bootstrap the source override (`lillyboga/suna` @ `eks-migration`) must
  be cleaned up once manifests land on `kortix-ai/suna`, or sources drift.

## Alternatives Considered

- **Flux CD.** Lighter and Kustomize-native, but its image-update and
  multi-tenancy story is less turnkey, it lacks a comparable first-class UI for
  the `ops.kortix.com` console, and it has no direct equivalent to the
  ApplicationSet PR generator we already rely on for previews.
- **Keep imperative CI deploys** (`helm upgrade` from Actions). Rejected: no
  drift detection, no self-heal, no single source of truth, and rollback means
  re-running a pipeline rather than reverting a commit.
