# CI/CD, Versioning & Releasing

The single source of truth for how Kortix builds, versions, and ships. Two
branches, one version number, four artifacts.

---

## TL;DR

- **`main`** = DEV. Every push auto-deploys to dev.
- **`prod`** = PROD. Only advanced by the **Promote** button; deploys the new ECS stack.
- **`VERSION`** file (repo root) = one number for the whole platform.
- A release = one `vX.Y.Z` GitHub Release bundling **API + Frontend + CLI + Desktop**.
- **Retag, don't rebuild**: prod ships the exact image bytes tested on dev.

```
PR ─► ci · codeql · secret-scan
 │ merge
 ▼
main (DEV) ──push──► dev-api.kortix.com (ECS) + dev.kortix.com (Vercel) + CLI dev-latest
 │
 │  "Promote to Production"  (bump VERSION · tag vX.Y.Z · fast-forward prod)
 ▼
prod (PROD) ─push─► api-prod.kortix.com (ECS) + kortix.com (Vercel)
                    + GitHub Release vX.Y.Z (CLI + desktop) + Docker :X.Y.Z/:latest
```

---

## The one version

`VERSION` (e.g. `0.9.0`) is the source of truth for **API, frontend, CLI, desktop**.
There is no per-component version.

| Context        | Version string        | How it gets there                                            |
| -------------- | --------------------- | ------------------------------------------------------------ |
| Dev (on main)  | `0.9.0-dev.<sha8>`    | `deploy-dev` build-args / env, computed from `VERSION` + sha |
| Release (prod) | `0.9.0`               | `promote` writes `VERSION`; `deploy-prod` stamps it          |
| Git tag        | `v0.9.0`              | created by `promote`                                         |

**Where each surface reports it:**

- **API** — `GET /v1/health` → `version`. Reads `process.env.KORTIX_VERSION`
  (baked into the image via the Dockerfile `ARG KORTIX_VERSION`; prod overrides
  it to the clean `X.Y.Z` via the ECS task-def env).
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
| `deploy-dev.yml`  | push → `main`                        | build+push dev API/frontend images, roll ECS `kortix-dev`, publish CLI `dev-latest` |
| `desktop.yml`     | push → main (`apps/desktop/**`) / dispatch | signed desktop installers → `desktop-dev-latest`              |
| `promote.yml`     | manual dispatch                      | bump `VERSION` · tag `vX.Y.Z` · fast-forward `prod`                 |
| `deploy-prod.yml` | push → `prod`                        | retag images → `:X.Y.Z`+`:latest`, cut Release, roll ECS `kortix-prod` |
| `deploy-prod-eks.yml` | push → `prod`                    | PARALLEL EKS path: `helm upgrade` `kortix-api` on `kortix-prod-eks` → `api-eks.kortix.com` (no-ops until the EKS stack is applied; never touches ECS). See `infra/EKS.md`. |

### Path-filtering (deploy-dev)

Only the surfaces whose paths changed rebuild:

- **api**: `apps/api`, `apps/kortix-sandbox-agent-server`, `apps/sandbox`,
  `apps/cli` (baked into the image), `packages`, `supabase/migrations`
  (run by `ensureSchema` at boot — must redeploy to apply), lockfiles, `VERSION`.
- **frontend**: `apps/web`, `packages`, lockfiles, `VERSION`.
- **cli**: `apps/cli`, `packages/starter`, `scripts/install.sh`, lockfiles, `VERSION`.

A docs-only push to main = a no-op CI run.

### Two deploy mechanisms (always parallel on a main push)

- **Backend** (dev-api / api-prod): GitHub Actions → **ECS Fargate** roll (OIDC,
  role `kortix-gha-ecs-deploy`).
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
3. It bumps `VERSION`, commits to `main`, tags `vX.Y.Z`, and fast-forwards `prod`.
4. The push to `prod` triggers `deploy-prod.yml`:
   - retag dev images → `:X.Y.Z` + `:latest` (no rebuild)
   - build prod CLI (clean version) → cut **GitHub Release `vX.Y.Z`**
   - register a task-def revision stamping `KORTIX_VERSION=X.Y.Z` → roll
     `kortix-prod` ECS (api-prod reports the clean version)
   - attach desktop installers (best-effort)
   - Vercel auto-deploys `prod` → kortix.com

`kortix.com/install` serves `main/scripts/install.sh` (canonical, always fresh
from GitHub raw). `kortix update` re-runs it. Stable channel → latest `vX.Y.Z`
release; `KORTIX_CHANNEL=dev` → `dev-latest` prerelease.

---

## Environments & hosts

| Env  | Branch | Frontend                | API (ECS Fargate)                  |
| ---- | ------ | ----------------------- | ---------------------------------- |
| DEV  | `main` | dev.kortix.com (Vercel) | dev-api.kortix.com → `kortix-dev`  |
| PROD | `prod` | kortix.com (Vercel)     | api-prod.kortix.com → `kortix-prod`|

AWS: account `935064898258`, region `us-west-2`. State in S3
(`kortix-terraform-state` + DynamoDB locks). Terraform under `infra/terraform`
(modules `network`, `acm-cloudflare`, `cloudflare-dns`, `ecs-api`).

### api.kortix.com — the Cloudflare Worker cutover switch

`api.kortix.com` is fronted by a Cloudflare **Worker** (`api-kortix-router`)
whose `ACTIVE_BACKEND` plain-text var selects the origin:

```
api.kortix.com ─► api-kortix-router Worker ─► ACTIVE_BACKEND
    new          → new-api.kortix.com   (old Lightsail box, v0.8.x)   ← live now
    ecs-fargate  → api-prod.kortix.com  (new ECS prod stack)          ← ready
    eks          → api-eks.kortix.com   (EKS prod stack)              ← parallel, see infra/EKS.md
```

**Apex cutover = flip `ACTIVE_BACKEND` → `ecs-fargate`** (one Worker var; instant,
sub-second, fully reversible — flip back to `new` to roll back). No DNS surgery.
The EKS stack (`infra/EKS.md`) adds an `eks` backend on the same switch: prove it
under `api-eks.kortix.com`, then flip `ACTIVE_BACKEND → eks`; roll back to
`ecs-fargate` anytime. ECS keeps running in parallel until EKS is proven.
`kortix.com` (Vercel) will likewise be pointed at the `prod`-branch frontend at
cutover. Until then api.kortix.com / kortix.com stay on the old box, untouched.

---

## Gotchas / rules

- **`SANDBOX_VERSION` ≠ app version.** It hashes sandbox snapshots; changing it
  rebuilds every project's image. App version uses `KORTIX_VERSION`.
- **Retag, never rebuild** between dev and prod — what you tested is what ships.
- **OIDC role perms**: `kortix-gha-ecs-deploy` needs `ecs:UpdateService`,
  `RegisterTaskDefinition`, `DescribeTaskDefinition`, and `iam:PassRole` on the
  task/exec roles (granted for both `kortix-dev` and `kortix-prod`).
- **Concurrency zombies**: `deploy-prod` has `cancel-in-progress: false`; a stuck
  queued run blocks new ones. Cancel the zombie, then re-dispatch.
- **`.env` files** (`apps/api/.env`, `apps/web/.env`) are gitignored, multi-profile
  (LOCAL/DEV/PROD), hold live secrets — edit values, never wholesale-overwrite.
- **Stripe price IDs** are per-account + hardcoded in `billing/services/tiers.ts`;
  the env's `STRIPE_SECRET_KEY` must be the account that owns them.
