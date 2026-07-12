---
name: dependency-upgrade
description: Weekly dependency upgrade loop for {{target_repo}}. Scans for outdated packages, applies upgrades on an isolated branch, runs the full verification suite in the sandbox, handles breaking changes with documented migrations, and opens a PR only when everything is green.
---

<skill name="dependency-upgrade">

<overview>
Keep `{{target_repo}}` dependencies current without creating risk. A weekly cron
re-prompts a persistent session, discovers what is behind, applies upgrades on an
isolated branch, runs the full suite inside the sandbox, and opens a PR only when
the suite is green. A failing upgrade never becomes a PR — it is logged, optionally
split, and retried the following week.

Proactive and schedule-driven; covers all outdated deps — patch, minor, and major —
with full verification and explicit breaking-change handling.
</overview>

<when-to-load>
- The weekly cron fires the upgrade sweep.
- A human asks the agent to upgrade dependencies or run a dep-upgrade sweep.
- A major version upgrade requires a tracked migration plan.
</when-to-load>

<workflow>

## Step 0 — Orient and resume

```sh
# Read the durable ledger first — last-run state, open PRs, known broken
# upgrades, and pinned packages to skip.
cat .kortix/memory/dependency-upgrade-log.md 2>/dev/null || echo "(no ledger yet)"

# Check any open upgrade PRs from a prior run.
gh pr list --repo {{target_repo}} --state open \
  --search 'in:title "chore(deps)" OR label:dependencies' \
  --json number,title,headRefName,statusCheckRollup,url
```

If an open PR from a prior run is still on CI or in review, note it and don't
duplicate the work. Drive a stalled-but-fixable PR to green; otherwise leave it
for review and move on.

## Step 1 — Freshen the repo

```sh
# Warm clone at /workspace/repo if present; else clone fresh (blobless).
if [ -d /workspace/repo/.git ]; then
  cd /workspace/repo && git fetch origin && git checkout main && git reset --hard origin/main
else
  git clone --filter=blob:none https://github.com/{{target_repo}}.git /workspace/repo
  cd /workspace/repo
fi

# Install so the toolchain can resolve versions.
pnpm install --frozen-lockfile 2>&1 | tail -20
```

Never start an upgrade on a stale base. Adapt the package manager (`pnpm` /
`npm` / `bun` / `pip` / `cargo`…) to the project's toolchain.

## Step 2 — Discover what is outdated

```sh
cd /workspace/repo
pnpm outdated --recursive --json 2>/dev/null || pnpm outdated --recursive
pnpm audit --json 2>/dev/null | jq '.advisories | length' || true
```

Parse into three tiers:

| Tier | Criteria | Default action |
|------|----------|----------------|
| **patch** | `x.y.Z` only | Apply + verify; group into one PR |
| **minor** | `x.Y.z` | Apply + verify; group by area or fold into the patch PR |
| **major** | `X.y.z` | Apply per package; verify with breaking-change analysis; own PR (or small cohesive group) |

Skip anything in the ledger's `pinned-packages` section.

## Step 3 — Isolated upgrade branch

```sh
cd /workspace/repo
BRANCH="upgrade/deps-$(date +%Y-W%V)"
git checkout -b "$BRANCH" origin/main   # or check out an existing branch from this week
```

One branch per weekly run.

## Step 4 — Apply the upgrades

**Patch + minor batch** — apply together:

```sh
cd /workspace/repo
npx taze minor --recursive --write 2>&1 | tee /tmp/taze-minor.log
pnpm install 2>&1 | tee /tmp/install-minor.log
```

**Major upgrades — one at a time:**

1. Read the changelog / GitHub releases for the package.
2. Grep the codebase for renamed/removed APIs.
3. Apply the bump + required migration in the same commit.
4. Run the suite (Step 5) before the next major. If it fails and the fix is
   > ~30 lines of non-trivial code, revert this major, file a tracked issue, and
   continue with the rest.

## Step 5 — Full verification suite (the gate)

The upgrade is not ready until every check is green.

```sh
cd /workspace/repo
pnpm install       2>&1 | tee /tmp/up-install.log
pnpm typecheck     2>&1 | tee /tmp/up-typecheck.log
pnpm lint          2>&1 | tee /tmp/up-lint.log
pnpm build         2>&1 | tee /tmp/up-build.log
pnpm test          2>&1 | tee /tmp/up-unit.log
pnpm test:integration 2>&1 | tee /tmp/up-integration.log   # if < ~10 min
pnpm audit --prod  2>&1 | tee /tmp/up-audit.log
```

**Interpreting failures:**

| Failure | Action |
|---|---|
| Type error from an upgraded package's types | Apply the migration (fix inline if 2–3 lines); else revert + file an issue |
| Test failure testing the upgraded package | If behavior legitimately changed, update the test; if it's a regression, revert + file |
| Test failure in an UNRELATED test | File a bug (likely pre-existing flake); don't revert unless you can prove causation |
| Build failure | Fix the import/config; if > 3 non-mechanical files, split the major into its own PR |
| Audit finds a NEW vuln from the upgrade | Revert + file. Never trade a clean audit for a dirty one |

## Step 6 — Commit

```sh
cd /workspace/repo
git add '**/package.json' pnpm-lock.yaml
git add -p            # review any migration source changes before staging
git commit -m "chore(deps): upgrade dependencies $(date +%Y-W%V)

Verification: typecheck ✓ lint ✓ build ✓ unit ✓ integration ✓ audit ✓"
```

## Step 7 — Open the PR (only when Step 5 is fully green)

A partial green (checks skipped/timed out) is NOT acceptable — rerun or debug.

```sh
cd /workspace/repo
git push origin "$BRANCH"
gh pr create --repo {{target_repo}} --base main --head "$BRANCH" \
  --title "chore(deps): upgrade dependencies $(date +%Y-W%V)" \
  --label dependencies \
  --body "Generated by the dependency upgrade agent. The full suite passed in the
sandbox before this PR was opened. Verification: install/typecheck/lint/build/
unit/integration/audit all ✓. A human owns the merge."
```

## Step 8 — Update the ledger

Append a dated entry to `.kortix/memory/dependency-upgrade-log.md` (see
`<ledger-format>`), then open + self-merge a scoped change request for the ledger
update only.

</workflow>

<ledger-format>
Lives at `.kortix/memory/dependency-upgrade-log.md`. Every run appends/updates the
current week's entry with: run timestamp, branch, PR link (or "not opened — why"),
an **Applied upgrades** table (package / from / to / tier), breaking-change
migrations, a **Verification** table, **Dropped / deferred** (package / reason /
issue), **Pinned packages** (do not upgrade), and **Blockers for next run**.
</ledger-format>

<guardrails>
- **No direct push to `main`.** The agent opens a PR and stops. A human merges.
- **Sandbox isolation.** Upgrades are applied and tested on an isolated branch in
  the session sandbox. Nothing reaches the repo until the suite is green and
  `git push` runs.
- **No lockfile tampering.** Never hand-edit the lockfile; regenerate via install.
- **Upgrades only, never downgrades.** If a package is pinned below latest, read
  the ledger's pin reason before touching it.
- **Secrets scoped.** The GitHub token is injected at runtime; never written to
  disk or logged.
- **One PR per run, one run per week.** If the first batch fails, fix or split and
  push to the same branch — don't open a duplicate.
- **CI must be green before merge.** The agent won't ask a human to merge a red PR.
</guardrails>

</skill>
