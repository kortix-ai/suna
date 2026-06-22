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
merge to main ─── deploy-dev.yml ... build image + node-pg-migrate dev DB + GitOps dev roll
                  qa-main.yml ..... e2e·visual·a11y (vs deployed target) + migration checks + publish Allure
                 │
nightly cron ──── qa-nightly.yml .. performance(k6)·DAST(ZAP)·pentest·mutation·chaos·static-security
                 │
PR → prod ─────── qa-release.yml .. full suite in sequence + gates (blocking pre-prod)
                 │  promote.yml gates on all-green check-runs
merge to prod ─── deploy-prod.yml . retag dev→version images, node-pg-migrate prod DB, publish, GitOps prod roll
```

Deploy lanes: `deploy-dev.yml` (push→dev, Trivy CRITICAL gate + SBOM + cosign + dev DB migrations + EKS GitOps), `deploy-preview.yml` (PR→Vercel preview), `deploy-prod.yml` (prod DB migrations + EKS GitOps), `hotfix-prod.yml` (break-glass — see below). IaC: `terraform-ci.yml`, `drata-compliance.yml`, `security-scan.yml` (weekly).

## Emergency hotfix (break-glass)

When an incident needs a fix faster than the ~3h `qa-release` gate allows, `hotfix-prod.yml`
**bypasses the full release suite** — but not all safety. It is `workflow_dispatch`-only and requires:
a `production-hotfix` GitHub Environment approval (required reviewers), a typed `confirm: HOTFIX PROD`,
and a mandatory `reason`. It still runs **fast safety checks** (`make typecheck unit contract api-coverage`,
plus optional Docker `integration`), builds the **exact** version images, and pushes the release commit
to `prod` — which triggers the normal `deploy-prod.yml` publish/rollout (no rebuild). So tagging and
deploy stay centralized; only the heavy regression/perf/security suites are skipped.

**Slack alerting** (via `.github/scripts/slack-notify.sh`, posting to `SLACK_HOTFIX_CHANNEL` or the
release channel): 🚨 *initiated* (the moment a break-glass run starts, with reason + who), ✅ *pushed to
prod*, and ❌ *FAILED* (if the run dies before the prod push — prod left unchanged). `deploy-prod` then
posts its own 🚀 *is live* message. Alerts skip gracefully if Slack secrets are unset.

Use it only when waiting for the full gate would materially prolong a production incident; everything
it skipped is still owed afterward (open a follow-up PR through the normal path).

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
| e2e · visual · a11y | qa-main.yml (post-merge) | tracked |
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

If a UI target var is unset, `qa-main` **skips browser regression with a notice** (it does not fail) — set `QA_WEB_BASE_URL` (e.g. to the preview/dev deployment) to enable it.

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

- **Secrets:** `DOTENV_PRIVATE_KEY` (api suite), `KE2E_*` (ke2e), `QA_REPORTS_ROLE_ARN`, `DRATA_IAC_PIPELINE_KEY`, `SLACK_BOT_TOKEN` + `SLACK_RELEASE_CHANNEL` (release/hotfix alerts), `SLACK_HOTFIX_CHANNEL` (optional dedicated incident channel; falls back to release channel), `PROD_HOTFIX_TOKEN` (optional, if branch protection blocks the bot push).
- **Vars:** `QA_WEB_BASE_URL` (enables UI regression), `A11Y_CONTRAST_MAX`, `QA_REPORTS_BUCKET`, `QA_AWS_REGION`, `QA_REPORTS_PUBLIC_BASE_URL`, `MIN_COVERAGE`.
- **Branch protection:** require `ci`, `package-tests`, `qa-pr` on `main`; require `qa-release` on `prod`; create the `production-hotfix` environment with reviewers.
- **QA report portal (`qa.kortix.com`):** served from the private `kortix-qa-reports` S3 bucket via the in-cluster nginx pod, behind **Cloudflare Access (Zero Trust)** — every report (incl. the per-PR Allure links) requires Kortix auth. Configured in `infra/terraform/modules/qa-portal` (`enable_access = true`); needs `TF_VAR_cloudflare_account_id`, a Zero Trust identity provider, and a Cloudflare token with *Account · Access: Apps and Policies · Edit*. `QA_REPORTS_PUBLIC_BASE_URL` should point at `https://qa.kortix.com`, so PR links land at `qa.kortix.com/reports/pr/<PR#>/<run-id>/` and prompt login.
