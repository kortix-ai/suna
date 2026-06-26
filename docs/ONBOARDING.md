# Onboarding — New Engineer to First Deploy in < 30 min

Goal: from a fresh laptop to (a) running the app locally and (b) understanding
how a change ships, in under half an hour. The platform is **EKS + Argo CD
GitOps** — you don't `kubectl apply` to deploy; you merge a PR and Argo
reconciles. Read `infra/GITOPS.md` and `infra/CICD.md` once; this is the fast
path.

| Env | Branch | Cluster | Region | API host |
|---|---|---|---|---|
| dev | `main` | `kortix-dev-eks` | us-west-2 | dev-api.kortix.com |
| staging | `staging` | `kortix-dev-eks` namespace `kortix-staging` | us-west-2 | staging-api.kortix.com |
| prod | `prod` | `kortix-prod-eks` | eu-west-2 | api.kortix.com |

---

## 1. Prerequisites (~10 min)

Install the toolchain:

```bash
# macOS (Homebrew)
brew install awscli kubectl helm node pnpm jq yq
brew install dotenvx/brew/dotenvx          # encrypted env management (see below)
# Argo Rollouts kubectl plugin (for canary inspection, optional)
brew install argoproj/tap/kubectl-argo-rollouts
# argocd CLI (optional, for app status/rollback)
brew install argocd
```

- **aws cli** — cluster access + image/secret operations (account
  `935064898258`).
- **kubectl / helm** — inspect the cluster + render the chart.
- **node + pnpm** — the monorepo is a pnpm workspace.
- **dotenvx** — decrypts the multi-profile `.env` files (this repo's secret
  story; load the `dotenvx-secrets` skill for the full model).

Get added to:
- GitHub org `kortix-ai` (repo access).
- AWS account `935064898258` (an SSO/IAM identity, for the EKS access entry).
- Cloudflare Access for `ops.kortix.com` (Argo CD) / `devops.<domain>` (Headlamp
  + Grafana) — gated by `@kortix.com` email.

---

## 2. Repo layout (the parts you'll touch)

```
apps/
  api/                     # the backend (Node) — ships as kortix/kortix-api
  web/                     # the frontend (Next.js) — Vercel builds it from source
  cli/  desktop/  sandbox/ # the other shipped surfaces
packages/                  # shared workspace packages
infra/
  GITOPS.md  CICD.md  EKS.md         # READ THESE
  k8s/
    charts/kortix-api/               # the Helm chart Argo renders
    envs/<env>/values.yaml           # image.tag here IS the deploy
    argocd/applications/<env>.yaml   # one Argo Application per env
    argocd/applicationsets/preview.yaml  # per-PR preview envs
  terraform/                         # cluster + platform (modules/eks, environments/*)
docs/
  runbooks/                # deploy, rollback, incident, DR, secrets, scaling
  INFRASTRUCTURE_PLAN.md  ONBOARDING.md  WHATS_MISSING.md
VERSION                    # one number for the whole platform
```

---

## 3. Local development (~5 min)

```bash
git clone https://github.com/kortix-ai/suna.git
cd suna
pnpm install

# Env: dotenvx-encrypted, multi-profile (local / dev / prod). The decryption
# keys live in Dotenv Armor — get them from a teammate, never commit them.
# Run with the local profile:
dotenvx run -f apps/api/.env -- pnpm --filter @kortix/api dev    # backend
pnpm --filter @kortix/web dev                                     # frontend (localhost:3000)
```

> `.env` files (`apps/api/.env`, `apps/web/.env`) are gitignored, hold live
> secrets, and are **multi-profile** — edit values, never wholesale-overwrite.
> For the full secrets model (encryption, profiles, rotation) load the
> `dotenvx-secrets` skill. For isolated parallel instances (own ports + Supabase
> project), use `pnpm worktree` (the `worktree` skill).

---

## 4. Get EKS access

EKS auth is via **EKS Access Entries** (your IAM/SSO principal is mapped to a
cluster access policy by Terraform). Once you're added, point kubectl at a
cluster:

```bash
# dev (you'll live here)
aws eks update-kubeconfig --name kortix-dev-eks --region us-west-2
kubectl -n kortix-dev get pods -o wide
kubectl -n kortix-dev get deploy kortix-api \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'

# prod (read-mostly; you'll rarely touch it directly)
aws eks update-kubeconfig --name kortix-prod-eks --region eu-west-2
kubectl -n kortix-prod get pods -o wide
```

If `kubectl` returns `error: You must be logged in to the server (Unauthorized)`,
your **access entry isn't created yet** — ask the platform owner to add your
principal (it's a Terraform change in the cluster state, `infra/EKS.md`). Browse
everything visually in **Headlamp** at `devops.<domain>` (one console spans both
clusters); metrics + Loki logs in **Grafana** at `devops.<domain>/grafana`.

---

## 5. The PR → preview-env loop (your first deploy)

This is the fastest way to see your change running on real infra. Labelling a PR
`preview` spins up an **ephemeral per-PR API** on dev-eks via the Argo CD
ApplicationSet (`infra/k8s/argocd/applicationsets/preview.yaml`).

1. Branch off `main`, make your change, open a PR.
2. CI runs (`ci.yml`, `codeql.yml`, `secret-scan.yml`).
3. **Add the `preview` label** to the PR. The ApplicationSet generates an Argo
   Application that deploys `kortix/kortix-api:pr-<head_sha>` into namespace
   `kortix-pr-<number>`, reachable at
   `pr-<number>.preview-api.kortix.com`.
   - It shares the **dev data plane** via the `kortix-preview-env` bundle and
     **never migrates** it (`INTERNAL_KORTIX_ENV=preview` → schema-ensure
     skipped). It's API-only, workers off, one tiny replica. A PR that needs a
     schema change applies the migration to dev deliberately (shared dev DB).
4. Inspect it:
   ```bash
   aws eks update-kubeconfig --name kortix-dev-eks --region us-west-2
   kubectl -n kortix-pr-<number> get pods
   curl -fsS https://pr-<number>.preview-api.kortix.com/v1/health | jq .
   ```
5. **Merge to `main`** → `deploy-dev.yml` builds `dev-<sha8>`, bumps
   `infra/k8s/envs/dev/values.yaml`, and Argo rolls dev. Removing the label /
   closing the PR prunes the preview namespace.

That's your first deploy: PR → preview → merge → dev. Production candidates then
go to **staging** via PR into `staging` (`main` -> `staging` for the full dev
candidate, or a targeted branch -> `staging` for a selective release).
Promoting to **prod** is a separate, reviewed flow — see
`docs/runbooks/deployment-procedure.md`.

---

## 6. Next reading

- `docs/runbooks/deployment-procedure.md` — dev + prod deploy in full.
- `docs/runbooks/rollback-procedure.md` — how to undo a bad deploy.
- `docs/runbooks/incident-response.md` — what to do when prod breaks.
- `infra/GITOPS.md` / `infra/CICD.md` / `infra/EKS.md` — the platform itself.
- `docs/WHATS_MISSING.md` — honest list of what's not built yet.
