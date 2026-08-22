---
name: flag-cleanup
description: Weekly reusable-session feature-flag cleanup for {{target_repo}}. Inventories every feature flag, classifies each as fully rolled out, long dead, partial rollout, or active experiment, removes the flag and the dead branch it guards on an isolated branch when the suite is green, and opens a PR — never touching a flag still mid-rollout.
---

<skill name="flag-cleanup">

<overview>
Keep the feature-flag inventory in `{{target_repo}}` small without ever risking a
live rollout. A weekly cron re-prompts a persistent session, which reads a ledger
of every flag's known age and rollout state, re-inventories the codebase,
classifies each flag, and removes only the ones that are provably safe: fully
rolled out (always-on) or long dead (no live check left, unchanged past
`{{min_flag_age_days}}` days). Anything still in partial rollout or an active
experiment is left completely alone and reported for a human to decide.

Proactive and schedule-driven; covers the full flag inventory every run, growing
the ledger over time as flags are removed or newly flagged.
</overview>

<when-to-load>
- The weekly cron fires the flag-cleanup sweep.
- A human asks the agent to check for stale feature flags or clean up dead flag
  branches.
- A flag that was previously flagged for human review needs re-classifying after
  its rollout state changed.
</when-to-load>

<workflow>

## Step 0 — Orient and resume

```sh
# Read the durable ledger first — known flags, their last-seen rollout state,
# what's already been removed, and what's already flagged for human review.
cat .kortix/memory/flag-cleanup-log.md 2>/dev/null || echo "(no ledger yet — first run)"

# Check any open cleanup PRs from a prior run.
gh pr list --repo {{target_repo}} --state open \
  --search 'in:title "chore(flags)" OR label:feature-flags' \
  --json number,title,headRefName,statusCheckRollup,url
```

If a prior cleanup PR is still on CI or in review, don't duplicate the work —
drive a stalled-but-fixable PR to green, otherwise leave it for review and move
on to flags it didn't cover.

## Step 1 — Freshen the repo

```sh
DEFAULT_BRANCH=$(gh repo view {{target_repo}} --json defaultBranchRef -q .defaultBranchRef.name)
if [ -d /workspace/repo/.git ]; then
  cd /workspace/repo && git fetch origin && git checkout "$DEFAULT_BRANCH" && git reset --hard "origin/$DEFAULT_BRANCH"
else
  git clone --filter=blob:none https://github.com/{{target_repo}}.git /workspace/repo
  cd /workspace/repo
  git checkout "$DEFAULT_BRANCH"
fi
```

Never classify or remove a flag against a stale checkout.

## Step 2 — Inventory every flag

```sh
cd /workspace/repo
# Flag definitions/registry — adapt the path to this repo's convention
# (e.g. flags.ts, feature-flags.json, a flags/ directory).
grep -rnE "(defineFlag|registerFlag|FEATURE_FLAGS|flags\.(json|ya?ml))" --include="*.ts" --include="*.tsx" --include="*.json" . 2>/dev/null

# Call sites — every place a flag is actually read.
grep -rnE "(isEnabled|useFeatureFlag|getFlag|flags\.[a-zA-Z_]+)\(" --include="*.ts" --include="*.tsx" . 2>/dev/null
```

For every flag found, record: name, where it's declared, every call site, and
(if the rollout percentage or state is tracked in-repo, e.g. a config file) its
current rollout value. Cross-reference `git log -1 --format=%ai -- <flag file or
last touched call site>` for the flag's last-touched date.

## Step 3 — Classify each flag

| Classification | Criteria | Action |
|---|---|---|
| **Fully rolled out** | Rollout is 100% / hardcoded `true` with no variant left, or explicitly marked GA | Remove — inline the "on" branch, delete the "off" branch |
| **Long dead** | No call site found anywhere in the repo, or unchanged (declaration and all call sites) for more than `{{min_flag_age_days}}` days with a rollout that was already at 0% or 100% | Remove entirely, including the dead declaration |
| **Partial rollout** | Rollout between 0% and 100% exclusive, percentage-based, or user/cohort-targeted | **Do not touch.** Log in the ledger for human review |
| **Active experiment** | Tied to an A/B test, gradual ramp still in progress, or flag age under `{{min_flag_age_days}}` days with no clear rollout signal | **Do not touch.** Log in the ledger for human review |

When a flag's rollout state can't be determined from the repo alone (e.g. it's
controlled by an external system this agent has no access to), treat it as
**ambiguous** and log it for human review — never guess.

## Step 4 — Isolated cleanup branch

```sh
cd /workspace/repo
BRANCH="chore/flag-cleanup-$(date +%Y-%m-%d)"
git checkout -b "$BRANCH" "origin/$DEFAULT_BRANCH"   # or check out an existing branch from this run
```

## Step 5 — Remove each eligible flag

For every flag classified **fully rolled out** or **long dead**:

1. Find every call site (`if (flags.x)`, `useFeatureFlag('x')`, etc.).
2. Inline the branch that survives (the "on" branch for fully-rolled-out flags;
   nothing survives for long-dead flags with no live call site).
3. Delete the now-unreachable branch and any helper code that only existed to
   support it.
4. Remove the flag's declaration from its registry/config file.
5. Remove now-unused imports and any tests that only exercised the dead branch;
   update tests that exercised the surviving branch so they no longer gate on
   the flag.

Do this one flag at a time so a single bad removal is easy to isolate and
revert.

## Step 6 — Full verification suite (the gate)

The removal is not ready until every check is green.

```sh
cd /workspace/repo
pnpm install       2>&1 | tee /tmp/flag-install.log
pnpm typecheck     2>&1 | tee /tmp/flag-typecheck.log
pnpm lint          2>&1 | tee /tmp/flag-lint.log
pnpm build         2>&1 | tee /tmp/flag-build.log
pnpm test          2>&1 | tee /tmp/flag-unit.log
pnpm test:integration 2>&1 | tee /tmp/flag-integration.log   # if < ~10 min
```

**Interpreting failures:**

| Failure | Action |
|---|---|
| Typecheck/build error from a removed branch's dependency | Fix the mechanical fallout (unused import, dangling type); if non-mechanical, revert that one flag's removal and log it |
| Test failure for the removed flag | Expected if the test only covered the dead branch — delete it; if it covered the surviving branch, fix the test |
| Test failure in an UNRELATED area | File it as a note (likely pre-existing); don't revert unless you can prove causation |
| Any failure you can't resolve in a few lines | Revert that flag's removal, log it as deferred with the reason, keep the rest of the batch |

## Step 7 — Commit

```sh
cd /workspace/repo
git add -A
git commit -m "chore(flags): remove stale feature flags $(date +%Y-%m-%d)

Removed: <flag-a> (fully rolled out), <flag-b> (long dead)
Verification: typecheck ✓ lint ✓ build ✓ unit ✓ integration ✓"
```

## Step 8 — Open the PR (only when Step 6 is fully green)

A partial green (checks skipped/timed out) is NOT acceptable — rerun or debug.

```sh
cd /workspace/repo
git push origin "$BRANCH"
gh pr create --repo {{target_repo}} --base "$DEFAULT_BRANCH" --head "$BRANCH" \
  --title "chore(flags): remove stale feature flags ($(date +%Y-%m-%d))" \
  --label feature-flags \
  --body "Generated by the flag-cleanup agent. The full suite passed in the
sandbox before this PR was opened.

**Removed (fully rolled out or long dead):**
- <flag-a> — fully rolled out, last touched <date>
- <flag-b> — long dead, no live call site found

**Left untouched (flagged for human review):**
- <flag-c> — partial rollout at <percentage>%
- <flag-d> — active experiment

A human owns the merge."
```

## Step 9 — Update the ledger

Append a dated entry to `.kortix/memory/flag-cleanup-log.md` (see
`<ledger-format>`), then open + self-merge a scoped change request for the
ledger update only.

</workflow>

<ledger-format>
Lives at `.kortix/memory/flag-cleanup-log.md`. Every run appends/updates the
current entry with: run timestamp, branch, PR link (or "not opened — why"), a
**Flag inventory** table (flag / declared location / rollout state / last
touched / classification), a **Removed this run** table (flag / classification /
files changed), a **Flagged for human review** table (flag / classification /
reason it wasn't touched), a **Verification** table, **Deferred removals**
(flag / reason / re-check date), and **Blockers for next run**.
</ledger-format>

<guardrails>
- **Partial rollout and active experiments are never removed.** These are always
  logged for human review, no exceptions, regardless of age.
- **No direct push to the default branch.** The agent opens a PR and stops. A
  human merges.
- **Sandbox isolation.** Removals are applied and tested on an isolated branch
  in the session sandbox. Nothing reaches the repo until the suite is green and
  `git push` runs.
- **Remove the branch, not just the flag.** A removal that deletes only the flag
  declaration but leaves dead conditional code behind is incomplete — finish the
  cleanup in the same PR.
- **When ambiguous, don't guess.** If a flag's rollout state can't be confirmed
  from the repo, log it for human review instead of classifying it as safe.
- **Secrets scoped.** The GitHub token is injected at runtime; never written to
  disk or logged.
- **One PR per run, one run per week.** If a batch fails, fix or split and push
  to the same branch — don't open a duplicate.
- **CI must be green before merge.** The agent won't ask a human to merge a red PR.
</guardrails>

</skill>
