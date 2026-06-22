# CI/CD, Versioning & Releasing

The single source of truth for how Kortix builds, versions, and ships. Two
branches, one version number, four artifacts.

---

## TL;DR

- **`main`** = DEV. Every push auto-deploys to dev.
- **`prod`** = PROD. Only advanced by the **Promote** button + reviewed release PR; deploys EKS by GitOps.
- **`VERSION`** file (repo root) = one number for the whole platform.
- A release = one `vX.Y.Z` GitHub Release bundling **API + Frontend + CLI + Desktop**.
- **Retag, don't rebuild**: prod ships the exact image bytes tested on dev.

```
PR ─► ci · codeql · secret-scan
 │ merge
 ▼
main (DEV) ──push──► dev-api.kortix.com (Worker → EKS) + dev.kortix.com (Vercel) + CLI dev-latest
 │
 │  "Promote to Production"  (open release/vX.Y.Z PR into prod; nothing publishes yet)
 ▼
prod (PROD) ─push─► api.kortix.com (Worker → EKS) + kortix.com (Vercel)
                    + GitHub Release vX.Y.Z (CLI + desktop) + Docker :X.Y.Z/:latest
```

---

## The one version

`VERSION` (e.g. `0.9.0`) is the source of truth for **API, frontend, CLI, desktop**.
There is no per-component version.

| Context        | Version string        | How it gets there                                            |
| -------------- | --------------------- | ------------------------------------------------------------ |
| Dev (on main)  | `0.9.0-dev.<sha8>`    | `deploy-dev` build-args / env, computed from `VERSION` + sha |
| Release (prod) | `0.9.0`               | `promote` writes `VERSION` on the release PR; `deploy-prod` stamps it after merge |
| Git tag        | `v0.9.0`              | created by `deploy-prod` after the release PR merges         |

**Where each surface reports it:**

- **API** — `GET /v1/health` → `version`. Reads `process.env.KORTIX_VERSION`
  (baked into the image via the Dockerfile `ARG KORTIX_VERSION`; prod also stamps
  `infra/k8s/envs/prod/values.yaml` `kortixVersion` so EKS reports clean `X.Y.Z`).
  - ⚠️ This is a **separate** var from `SANDBOX_VERSION`. `SANDBOX_VERSION` is
    load-bearing for sandbox snapshot content-hashing — never repurpose it for the
    app version or every project's sandbox image rebuilds.
- **Frontend** — `next.config.ts` resolves it (build env → root `VERSION` file →
  `dev`), inlined as `NEXT_PUBLIC_KORTIX_VERSION` and exposed in
  `/api/runtime-config` (`VERSION`).
- **CLI** — `kortix version`. Baked at compile time via
  `--define process.env.KORTIX_CLI_VERSION`.

---

## The 4 artifacts

| Artifact                     | What           | Ships to                                   |
| ---------------------------- | -------------- | ------------------------------------------ |
| `kortix/kortix-api`          | Backend image  | Docker Hub (multi-arch amd64+arm64)        |
| `kortix/kortix-frontend`     | Web image      | Docker Hub (for **self-hosters** only)     |
| `kortix` CLI                 | 4 binaries     | GitHub Release (darwin/linux × arm64/x64)  |
| Desktop                      | Installers     | GitHub Release (.dmg/.msi/.AppImage)       |

> Our hosted sites do **not** use the frontend image — Vercel builds dev.kortix.com
> (from `main`) and kortix.com (from `prod`) from source. The frontend image is
> only for self-hosters.

---

## Workflows (`.github/workflows/`)

| File              | Trigger                              | Does                                                                 |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------- |
| `ci.yml`          | PR → main/prod                       | typecheck · web build · sandbox/cli/desktop smoke                   |
| `codeql.yml`      | push/PR main+prod, weekly            | SAST                                                                |
| `secret-scan.yml` | PR → main/prod                       | gitleaks                                                            |
| `deploy-dev.yml`  | push → `main`                        | build+push dev API/frontend images, run dev DB migrations, bump EKS GitOps values, publish CLI `dev-latest` |
| `desktop.yml`     | push → main (`apps/desktop/**`) / dispatch | signed desktop installers → `desktop-dev-latest`              |
| `promote.yml`     | manual dispatch                      | open a reviewed `release/vX.Y.Z` PR into `prod`; no tag/release/deploy until merge |
| `deploy-prod.yml` | push → `prod`                        | retag images → `:X.Y.Z`+`:latest`, run prod DB migrations, cut Release, watch EKS GitOps rollout |

### Path-filtering (deploy-dev)

Only the surfaces whose paths changed rebuild:

- **api**: `apps/api`, `apps/kortix-sandbox-agent-server`, `apps/sandbox`,
  `apps/cli` (baked into the image), `packages`, `packages/db/migrations`
  (applied by the `migrate-db` jobs before the EKS roll), lockfiles, `VERSION`.
- **frontend**: `apps/web`, `packages`, lockfiles, `VERSION`.
- **cli**: `apps/cli`, `packages/starter`, `scripts/install.sh`, lockfiles, `VERSION`.

A docs-only push to main = a no-op CI run.

### Two deploy mechanisms (always parallel on a main push)

- **Backend** (dev-api / api): GitHub Actions builds/retags images and bumps
  `infra/k8s/envs/<env>/values.yaml`; Argo CD rolls EKS. ECS Fargate remains a
  warm standby behind the Cloudflare Worker, not the primary deploy path.
- **Frontend** (dev.kortix.com / kortix.com): **Vercel git integration** —
  auto-builds from the branch, *not* a workflow step.

### Desktop is decoupled from the release

`deploy-prod`'s `github-release` job needs only `[version, retag-images,
build-cli]` — it cuts the `vX.Y.Z` release in ~2 min and does **not** wait on
desktop (slow/scarce signed mac/win runners that can hang or fail on certs). A
separate `attach-desktop` job uploads installers to the release afterward,
best-effort. Desktop can never block or delay a release.

---

## How to release (promote)

1. Actions → **Promote to Production** → Run workflow.
2. Pick a `bump` (patch/minor/major) — or set an explicit `version`.
3. It freezes `release/vX.Y.Z`, stamps `VERSION` / `RELEASE_NOTES.md` /
   `RELEASE_SOURCE_SHA`, bumps prod GitOps values, and opens a PR into `prod`.
4. A reviewer merges the PR. The push to `prod` triggers `deploy-prod.yml`:
   - retag dev images → `:X.Y.Z` + `:latest` (no rebuild)
   - build prod CLI (clean version) → cut **GitHub Release `vX.Y.Z`**
   - run node-pg-migrate against prod before pods roll
   - watch Argo CD roll `kortix-prod` on EKS (api reports the clean version)
   - attach desktop installers (best-effort)
   - Vercel auto-deploys `prod` → kortix.com

`kortix.com/install` serves `main/scripts/install.sh` (canonical, always fresh
from GitHub raw). `kortix update` re-runs it. Stable channel → latest `vX.Y.Z`
release; `KORTIX_CHANNEL=dev` → `dev-latest` prerelease.

---

## Environments & hosts

| Env  | Branch | Frontend                | Public API                         |
| ---- | ------ | ----------------------- | ---------------------------------- |
| DEV  | `main` | dev.kortix.com (Vercel) | dev-api.kortix.com → Worker → EKS `kortix-dev` |
| PROD | `prod` | kortix.com (Vercel)     | api.kortix.com → Worker → EKS `kortix-prod` |

AWS: account `935064898258`; dev EKS runs in `us-west-2`, prod EKS in
`eu-west-2`. Terraform state lives in S3 (`kortix-terraform-state` + DynamoDB
locks). Terraform under `infra/terraform` owns EKS, ECS standby, networking,
ACM/Cloudflare DNS, and platform add-ons.

### api.kortix.com — the Cloudflare Worker cutover switch

`api.kortix.com` is fronted by a Cloudflare **Worker** (`api-kortix-router`)
whose `ACTIVE_BACKEND` plain-text var selects the origin:

```
api.kortix.com ─► api-kortix-router Worker ─► ACTIVE_BACKEND
    eks          → api-eks.kortix.com          ← live primary
    ecs-fargate  → api-ecs-fargate.kortix.com  ← warm standby
```

Failover = flip `ACTIVE_BACKEND` to `ecs-fargate` (one Worker var; instant and
reversible), then flip back to `eks` after recovery. Verify with the `X-Backend`
header on `/v1/health`. ECS stays available as standby; EKS is the primary path.

---

## Gotchas / rules

- **`SANDBOX_VERSION` ≠ app version.** It hashes sandbox snapshots; changing it
  rebuilds every project's image. App version uses `KORTIX_VERSION`.
- **Retag, never rebuild** between dev and prod — what you tested is what ships.
- **OIDC role perms**: the EKS deploy roles (`kortix-gha-eks-deploy-dev` /
  `kortix-gha-eks-deploy`) need cluster read/watch access plus contents write
  where the workflow pushes GitOps value changes.
- **Concurrency zombies**: `deploy-prod` has `cancel-in-progress: false`; a stuck
  queued run blocks new ones. Cancel the zombie, then re-dispatch.
- **`.env` files** (`apps/api/.env`, `apps/web/.env`) are gitignored, multi-profile
  (LOCAL/DEV/PROD), hold live secrets — edit values, never wholesale-overwrite.
- **Stripe price IDs** are per-account + hardcoded in `billing/services/tiers.ts`;
  the env's `STRIPE_SECRET_KEY` must be the account that owns them.
