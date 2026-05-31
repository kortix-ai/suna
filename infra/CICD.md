# CI/CD

A branch-based dev→prod model with one unified version.

## Branch model

| Branch       | Role | Deploys                                                              |
| ------------ | ---- | ------------------------------------------------------------------- |
| `main`       | DEV  | Every push auto-deploys everything as `X.Y.Z-dev.<sha8>`.            |
| `production` | PROD | Receives promotions only; deploys one clean version `X.Y.Z`.        |

- `main` is the working branch. Open PRs against `main`; CI gates them.
- `production` only ever advances via the **Promote** workflow.

## Version flow

The root [`VERSION`](../VERSION) file is the single source of truth for the API,
web, CLI, and desktop.

- **Dev** (on `main`): artifacts are stamped `$(cat VERSION)-dev.<sha8>`.
- **Promoted** (on `production`): artifacts are the clean `$(cat VERSION)` =
  `X.Y.Z`.

[`scripts/version.sh`](../scripts/version.sh) computes these:

```
scripts/version.sh          # X.Y.Z         (clean / promoted)
scripts/version.sh --dev    # X.Y.Z-dev.<sha8>
scripts/version.sh --tag    # vX.Y.Z
DEV=1 scripts/version.sh    # X.Y.Z-dev.<sha8>
```

## How to promote (cut a release)

1. Run the **Promote to Production** workflow (`promote.yml`) via the Actions tab
   (workflow_dispatch).
2. Choose a `bump` (patch/minor/major) — or pass an explicit `version`.
3. The workflow bumps `VERSION`, commits it to `main`, tags `vX.Y.Z`, and
   fast-forwards `production` to that commit.
4. The push to `production` triggers **Deploy Prod** (`deploy-prod.yml`): it
   retags the dev images to `:X.Y.Z` + `:latest` and cuts the GitHub Release
   `vX.Y.Z`. The prod ECS roll stays gated (see below).

## The 6 workflows

| Workflow            | Trigger                          | Purpose                                                                                  |
| ------------------- | -------------------------------- | ---------------------------------------------------------------------------------------- |
| `ci.yml`            | PR → `main`                      | Typecheck/build gates (API, frontend, sandbox agent, CLI, desktop).                      |
| `codeql.yml`        | push/PR → `main`,`production` + weekly | CodeQL SAST (SOC 2 CC7.1/CC8.1).                                                     |
| `secret-scan.yml`   | PR → `main`,`production`          | gitleaks secret scan.                                                                     |
| `deploy-dev.yml`    | push → `main` + dispatch         | Build+push dev images, roll dev ECS, publish dev CLI + desktop to the `dev-latest` prerelease. |
| `promote.yml`       | dispatch                         | Bump VERSION, tag `vX.Y.Z`, fast-forward `production`.                                    |
| `deploy-prod.yml`   | push → `production` + dispatch   | Retag images → `vX.Y.Z`+`latest`, cut GitHub Release `vX.Y.Z`, [gated] roll prod ECS.    |

### Artifacts

- **Images:** `kortix/kortix-api` and `kortix/kortix-frontend` on Docker Hub.
  - Dev: `:dev-<sha8>` + `:dev-latest`.
  - Prod: `:X.Y.Z` + `:latest` (retagged from `:dev-latest`, zero rebuild).
- **CLI:** 4 cross-compiled binaries (darwin/linux × arm64/x64) attached to a
  GitHub Release.
  - Dev → `dev-latest` prerelease (defaults to `dev-api.kortix.com`).
  - Prod → `vX.Y.Z` release (defaults to `api.kortix.com`).
  - Installed via `scripts/install.sh` (served at `kortix.com/install`).
- **Desktop:** signed installers (.dmg/.msi/.AppImage) attached to the same
  releases as the CLI.
- **Frontend (hosted):** `dev.kortix.com` and `kortix.com` are deployed by
  Vercel from `main` and `production` respectively — not by these workflows.

## Going live on prod (checklist)

The prod ECS roll in `deploy-prod.yml` is DORMANT by design. To turn it on:

1. **Apply terraform** for the prod environment (`infra/terraform`, env/prod) so
   the `kortix-prod` ECS cluster + service exist.
2. **Create the `production` GitHub Environment** with a required reviewer
   (manual approval gate).
3. **Set the repo variable `PROD_LIVE=true`** (Settings → Secrets and variables
   → Actions → Variables). Until then the `deploy-api` job is skipped.
4. **Configure Vercel:** set the Production Branch to `production`, and assign a
   `main` → `dev.kortix.com` preview/environment so dev tracks `main`.

Until step 3, `deploy-prod.yml` still retags images and cuts the GitHub Release
on every promotion — only the ECS roll is held back.
