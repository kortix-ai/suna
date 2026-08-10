# CI/CD Pipeline

How code reaches production at Kortix, and which tests gate each step. Companion to [`../TESTING.md`](../TESTING.md) and [`TEST_ARCHITECTURE.md`](./TEST_ARCHITECTURE.md).

## Tiered model

The pipeline mirrors the test pyramid: fast/cheap on every PR, expensive/slow on a schedule or at the release gate. Every CI lane maps 1:1 to a `make` target so **CI == local**.

```
PR opened ─┬─ ci.yml ............. build/typecheck per app + Trivy fs + dependency scan
           ├─ package-tests.yml .. all co-located bun:test suites (pkgs+apps) + focused-test guard + SAST (advisory)
           ├─ qa-pr.yml .......... make ci-pr: lint·typecheck·unit(cov)·integration·contract·api·gates → Allure PR comment
           ├─ codeql.yml ......... SAST (security-and-quality)
           └─ secret-scan.yml .... gitleaks on the PR range
                 │  (all must pass)
push/merge main ─ deploy-dev.yml ... build images + dev DB migrations + ECS Fargate roll
                 │
promote/PR staging ─ build-staging.yml . build exact staging images
                     deploy-staging.yml . staging DB migrations + ECS Fargate roll
                     qa-staging.yml ... e2e·visual·a11y (vs deployed target) + migration checks + publish Allure
                 │
nightly cron ──── qa-nightly.yml .. performance(k6)·DAST(ZAP)·pentest·mutation·chaos·static-security
                 │
PR staging → prod ─ qa-release.yml .. full suite in sequence + gates (blocking pre-prod)
                 │  promote.yml gates on all-green check-runs
merge to prod ─── deploy-prod.yml . retag staging→version images, migrate prod DB, publish, ECS Fargate roll
```

Deploy lanes: `deploy-dev.yml` builds and rolls API, gateway, and frontend ECS services while keeping the Vercel frontend path active. `build-staging.yml`, `deploy-staging.yml`, and `qa-staging.yml` build, deploy, and verify the staging release candidate. `deploy-preview.yml` builds isolated PR-specific API, gateway, and frontend images, deploys one ECS Fargate preview, and creates the parallel Vercel preview. `promote.yml` opens the reviewed staging-to-prod release PR. `deploy-prod.yml` applies prod DB migrations, retags the tested images, deploys ECS Fargate, and publishes the release. IaC runs through `terraform-ci.yml`. Compliance and security schedules run through `drata-compliance.yml` and `security-scan.yml`.

## Urgent production fixes

Use the same release lane as every other production change:

1. Land the fix on `main`, or open a targeted branch directly into `staging`.
2. Advance `staging` by PR.
3. Let `build-staging.yml`, `deploy-staging.yml`, and `qa-staging.yml` produce and verify staging artifacts.
4. Run `promote.yml` to open the reviewed release PR into `prod`.
5. Merge the release PR; `deploy-prod.yml` publishes and rolls production.

There is no separate workflow that pushes `prod` directly. Keeping the single staging→prod path avoids image/source drift, branch-protection bypasses, and Slack noise from failed partial release attempts.

## What blocks a merge

| Gate | Lane | Blocking? |
|---|---|---|
| **Every source change ships with a test** | package-tests.yml (`tests-required`) | yes (override: `no-tests-needed` label) |
| Build + typecheck per app | ci.yml | yes |
| Trivy fs (CRITICAL) + dependency scan | ci.yml | yes |
| Co-located unit suites (all pkgs/apps) | package-tests.yml | yes |
| Focused-test guard (`.only`) | package-tests.yml | yes |
| Unit coverage ≥ 80% (product code) | qa-pr.yml → `make gates` | yes |
| Integration · contract · api/ke2e route-coverage | qa-pr.yml | yes |
| gitleaks (PR range) | secret-scan.yml | yes |
| SAST (Semgrep) | package-tests.yml (advisory ratchet), qa-nightly/release (blocking) | mixed |
| e2e · visual · a11y | qa-staging.yml (post-staging) | tracked |
| Full suite + gates | qa-release.yml | yes (pre-prod) |

`make gates` (`tests/scripts/quality-gates.sh`) fails on: any JUnit failure, unit line coverage `< MIN_COVERAGE` (80%), any CRITICAL/HIGH SARIF finding, any k6 threshold breach.

## Targets & how lanes reach a running system

Tests that need a live system read their target from env/vars — never hardcoded:

| Lane | Target var | Source |
|---|---|---|
| e2e / visual / a11y | `E2E_BASE_URL` | `vars.QA_WEB_BASE_URL` (or `workflow_dispatch` input) — a deployed web URL (preview/dev/staging) |
| api / ke2e / smoke | `KE2E_API_URL`, `KE2E_SUPABASE_URL`, `KE2E_OWNER_*`, `KE2E_ADMIN_TOKEN` | GitHub Actions **secrets** (point at `dev-api.kortix.com`, never prod) |
| performance / DAST | `BASE_URL` / `TARGET_URL` | `vars` (dedicated perf/QA target) |
| Report publish | `QA_REPORTS_ROLE_ARN` (OIDC), `QA_REPORTS_BUCKET` | secrets/vars (S3 + `qa.kortix.com`) |

If a UI target var is unset, `qa-staging` **skips browser regression with a notice** (it does not fail) — set `QA_WEB_BASE_URL` (e.g. to the staging deployment) to enable it.

## Accessibility gate (ratchet)

`tests/accessibility/landing.a11y.spec.ts` **blocks on structural serious/critical violations** (missing button/link names, labels, roles, `lang`, etc.) and **ratchets `color-contrast` as tracked design debt**: it fails only if contrast nodes exceed `A11Y_CONTRAST_MAX` (default `560`, set via repo var). Lower the ceiling as the design palette is brought to WCAG AA — it can never silently regress.

## Visual regression (per-platform baselines)

`tests/visual/` snapshots are **platform-suffixed** (`{arg}-{projectName}-{platform}`) — macOS and CI-Linux keep separate baselines, so a local capture never breaks CI. Baselines are committed per platform; CI generates its `-linux` baseline on first run (or via `make visual` with `--update-snapshots` on a Linux runner) and that artifact is committed. `maxDiffPixelRatio: 0.01` absorbs sub-pixel anti-aliasing only.

## Caching & cost

`package-tests.yml` caches the pnpm store keyed on `pnpm-lock.yaml`. Add the same `actions/cache` block to other lanes as needed. Playwright browsers are installed per-run in the UI lane (cache with `~/.cache/ms-playwright` if it becomes a bottleneck).

## Adding a test (and keeping CI green)

1. **Unit** for a new export → co-located `*.test.ts` (`bun:test`); runs in `package-tests`.
2. **New/changed route** → a `ke2e` flow in `tests/src/flows/` with `meta.routes` in sync; the route-coverage gate enforces it.
3. **New cross-cutting suite** → a folder under `tests/` + a `make` target + a JUnit reporter so `make gates` and Allure pick it up.
4. Run `make fast` (lint·typecheck·unit·smoke) before pushing; `pnpm test` for all co-located suites.

## Required repo configuration (one-time)

- **Secrets:** `DOTENV_PRIVATE_KEY` (api suite), `KE2E_*` (ke2e), `QA_REPORTS_ROLE_ARN`, `DRATA_IAC_PIPELINE_KEY`, `SLACK_BOT_TOKEN` + `SLACK_RELEASE_CHANNEL` (release alerts).
- **Vars:** `QA_WEB_BASE_URL` (enables UI regression), `A11Y_CONTRAST_MAX`, `QA_REPORTS_BUCKET`, `QA_AWS_REGION`, `QA_REPORTS_PUBLIC_BASE_URL`, `MIN_COVERAGE`.
- **Branch protection:** keep `main` push-friendly (no force/delete), keep `staging` as the pre-prod branch for PR-based human/code changes plus bot GitOps pin commits, require `qa-release` on `prod`. See `docs/specs/2026-06-25-dev-staging-prod-release-topology.md`.
- **Staging DB isolation:** `deploy-staging.yml` must fail if `STAGING_DATABASE_URL`
  is missing; staging must not fall back to dev, KE2E, or prod Postgres for
  migrations or runtime.
- **QA report portal (`qa.kortix.com`):** served from the private `kortix-qa-reports` S3 bucket via the in-cluster nginx pod, behind **Cloudflare Access (Zero Trust)** — every report (incl. the per-PR Allure links) requires Kortix auth. Configured in `infra/terraform/modules/qa-portal` (`enable_access = true`); needs `TF_VAR_cloudflare_account_id`, a Zero Trust identity provider, and a Cloudflare token with *Account · Access: Apps and Policies · Edit*. `QA_REPORTS_PUBLIC_BASE_URL` should point at `https://qa.kortix.com`, so PR links land at `qa.kortix.com/reports/pr/<PR#>/<run-id>/` and prompt login.
