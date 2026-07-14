---
name: docs-sync
description: Daily reusable-session docs sync for {{target_repo}}. Reads the commits that landed since the last run, maps each change to the documentation pages it made inaccurate, rewrites those pages under {{docs_path}} to match the code, and opens a PR only when there's real drift to fix.
---

<skill name="docs-sync">

<overview>
Keep the docs under `{{docs_path}}` in `{{target_repo}}` accurate to the code without
waiting for a scheduled audit. A daily cron re-prompts a persistent session, which
reads a ledger to find the last commit it processed, pulls everything that landed
since then, figures out which docs pages that code touches, rewrites them to match,
and opens one PR for the day's drift. Nothing merges without a human, and the agent
never edits code — only documentation and README files.

Proactive and schedule-driven; covers whatever landed on the default branch since
the last run, however many commits that is.
</overview>

<when-to-load>
- The daily cron fires the docs sync run.
- A human asks the agent to check docs for drift against recent code.
- A prior run left the ledger checkpoint stale (e.g. after an incident) and docs
  need to catch up across a wider commit range.
</when-to-load>

<workflow>

## Step 0 — Orient and resume

```sh
# Read the durable ledger first — the last commit SHA processed, any open
# docs PR from a prior run, and pages known to intentionally lag the code.
cat .kortix/memory/docs-sync-log.md 2>/dev/null || echo "(no ledger yet — first run)"

# Check for an open docs PR from a prior run before opening a new one.
gh pr list --repo {{target_repo}} --state open \
  --search 'in:title "docs:" OR label:documentation' \
  --json number,title,headRefName,statusCheckRollup,url
```

If a prior docs PR is still open and unreviewed, don't duplicate it — extend that
branch with today's changes instead of opening a second one.

## Step 1 — Freshen the repo

```sh
if [ -d /workspace/repo/.git ]; then
  cd /workspace/repo && git fetch origin && git checkout main && git reset --hard origin/main
else
  git clone --filter=blob:none https://github.com/{{target_repo}}.git /workspace/repo
  cd /workspace/repo
fi
```

## Step 2 — Find what landed since the last run

```sh
cd /workspace/repo
LAST_SHA=$(grep -m1 '^checkpoint:' .kortix/memory/docs-sync-log.md | awk '{print $2}')
if [ -z "$LAST_SHA" ]; then
  # First run: seed from HEAD, do a light backward scan instead of the whole history.
  LAST_SHA=$(git rev-parse HEAD~20)
fi
git log --oneline "$LAST_SHA"..HEAD
git diff "$LAST_SHA"..HEAD --stat
```

If there are no commits since `$LAST_SHA`, skip straight to Step 7 — advance the
checkpoint to current `HEAD` and stop. Never open an empty PR.

## Step 3 — Read the code, not just the diff

For each commit in range, don't just read the patch — read the changed function,
handler, config, or flag definition in full to understand the resulting behavior,
not only what moved.

```sh
git show "$LAST_SHA"..HEAD --name-only | sort -u   # touched files across the range
git log -p "$LAST_SHA"..HEAD -- <touched-file>      # full history of one file's changes
```

Classify each change: renamed/added/removed env var or config key, new or removed
API endpoint, changed CLI flag or command, changed setup/install step, changed
architecture or data flow.

## Step 4 — Map changes to affected docs

```sh
# Search the docs tree and READMEs for anything referencing the old behavior.
grep -rn "<old-symbol-or-var-name>" {{docs_path}} README.md **/README.md 2>/dev/null
```

Build a list of (code change → doc page) pairs. If a change has no matching doc
page but clearly needs one (e.g. a new public endpoint), note it as a new page to
draft rather than skipping it.

## Step 5 — Rewrite the affected pages

Load the project's existing docs standard from `{{docs_path}}` itself — the
structure, terminology, and page ownership already in use — and write to match it
rather than inventing a new style. For each mapped page:

- Update the specific section the change affects; don't rewrite the whole page.
- A renamed env var → update every reference in the setup guide.
- A new endpoint → draft a reference entry from the actual handler signature and
  behavior, not from the PR description.
- A removed feature or flag → strip the stale section entirely rather than
  marking it "deprecated" if it's fully gone from the code.

Docs and READMEs are the only write surface. Never touch code to make a doc read
as accurate — if the code is wrong, log it in the ledger's blockers, don't fix it.

## Step 6 — Verify and open the PR

```sh
cd /workspace/repo
BRANCH="docs-sync/$(date +%Y-%m-%d)"
git checkout -b "$BRANCH"
git add {{docs_path}} README.md **/README.md
git commit -m "docs: sync with $(git rev-parse --short "$LAST_SHA")..$(git rev-parse --short HEAD)"
git push origin "$BRANCH"
gh pr create --repo {{target_repo}} --base main --head "$BRANCH" \
  --title "docs: sync with recent changes ($(date +%Y-%m-%d))" \
  --label documentation \
  --body "Generated by the docs sync agent. Covers commits $LAST_SHA..HEAD. Each
section below links the commit that prompted the change and states why the old
text no longer matched the code. A human owns the merge."
```

One PR per run, all of today's drift grouped together, reasoning attached per page.

## Step 7 — Update the ledger

Append a dated entry to `.kortix/memory/docs-sync-log.md` (see `<ledger-format>`)
with the new checkpoint SHA, then advance it whether or not a PR was opened — the
checkpoint always moves to the `HEAD` this run inspected.

</workflow>

<ledger-format>
Lives at `.kortix/memory/docs-sync-log.md`. Every run appends/updates the current
entry with: run timestamp, `checkpoint: <sha>` (the commit this run's scan ended
at — the next run's starting point), the commit range processed, PR link (or
"not opened — no doc-visible drift"), a **Pages changed** table (page / commit that
prompted it / what changed), **Drift intentionally left** (page / reason), and
**Blockers for next run** (e.g. code itself looked wrong, needs a human to confirm
intent before docs can be written).
</ledger-format>

<guardrails>
- **No direct push to `main`.** The agent opens a PR and stops. A human merges.
- **Docs-only write surface.** Only files under `{{docs_path}}` and READMEs are
  ever staged or committed. The rest of the codebase is read-only context.
- **Never edit code to make docs "true."** If the code looks wrong, log it as a
  blocker for a human — don't change it.
- **Sandbox isolation.** The clone, the diff read, and the rewrite all happen in
  the session sandbox. Only the docs PR leaves it.
- **Secrets scoped.** The GitHub token is injected at runtime; never written to
  disk, echoed, or logged.
- **One PR per run.** Group the day's drift into a single PR; extend an existing
  open docs PR rather than opening a duplicate.
- **No empty PRs.** If nothing doc-visible changed since the last checkpoint,
  advance the ledger and stop.
- **Checkpoint always advances.** Even a skipped or partial run moves the ledger
  checkpoint forward so the next run doesn't reprocess the same commits.
</guardrails>

</skill>
