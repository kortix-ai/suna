---
name: flaky-test-quarantine
description: Daily reusable-session flaky-test triage for {{target_repo}}. Pulls CI run history from GitHub, scores each test's non-determinism against a persistent per-test ledger, and once a test reaches {{quarantine_threshold}} opens a quarantine PR (skip + reason, never delete) plus a running tracking issue, and posts a summary to {{alert_channel}}. Never merges.
---

<skill name="flaky-test-quarantine">

<overview>
Detect tests that pass and fail non-deterministically on unchanged code, and
get the worst offenders out of the critical path before they erode trust in
CI — without ever deleting them or merging on the agent's own authority. This
is one persistent session (`session_mode: reuse`) re-prompted daily: each run
pulls the CI run history since the last check, updates a durable per-test
flakiness ledger, and for any test crossing the threshold, opens a single
quarantine PR that skips it with a reason, rolls it into one running tracking
issue, and posts a summary to Slack.

Proactive and schedule-driven; the ledger is what makes flakiness measurable —
a test's score reflects weeks of runs, not one bad day.
</overview>

<when-to-load>
- The daily cron fires the triage sweep.
- A human asks the agent to check whether a specific test is flaky.
- A previously quarantined test needs re-evaluating after a fix lands.
</when-to-load>

<workflow>

## Step 0 — Orient and resume

```sh
cat .kortix/memory/flaky-test-ledger.md 2>/dev/null || echo "(no ledger yet)"

gh issue list --repo {{target_repo}} --state open \
  --search 'in:title "Flaky test quarantine tracker"' \
  --json number,title,url

gh pr list --repo {{target_repo}} --state open \
  --search 'in:title "test(quarantine)"' \
  --json number,title,headRefName,statusCheckRollup,url
```

If a quarantine PR from a prior run is still open, don't duplicate it — push
more commits to it this run if more tests cross the threshold, otherwise leave
it for review.

## Step 1 — Pull CI run history since the last check

```sh
gh run list --repo {{target_repo}} --branch main --limit 50 \
  --json databaseId,conclusion,createdAt,headSha,workflowName > /tmp/runs.json

# For each run since the ledger's last processed run_id, pull the per-test
# report artifact the workflow produces (JUnit/XML or equivalent).
gh api repos/{{target_repo}}/actions/runs/<RUN_ID>/artifacts \
  --jq '.artifacts[] | select(.name | test("test-results|junit")) | .id'
gh api repos/{{target_repo}}/actions/artifacts/<ARTIFACT_ID>/zip > /tmp/artifact.zip
unzip -o /tmp/artifact.zip -d /tmp/artifact-<RUN_ID>
```

Parse every report into `(test_name, file, outcome, run_id, head_sha,
timestamp)` tuples. Only process runs newer than the ledger's last processed
`run_id` — don't re-score history already folded in.

## Step 2 — Update the flakiness score per test

For each observed test, append its new outcomes to the ledger's history and
recompute:

- **Flip count** — how many times the outcome changed between consecutive
  runs of the *same* `head_sha` (a rerun) or of near-identical code (no change
  touching the test or its subject between runs).
- **Failure rate** — failures / total observations over the ledger's rolling
  window (default: last 20 runs per test).
- **Flakiness score** — flip count weighted above raw failure rate: a test
  that fails consistently on broken code is not flaky; a test that flips
  outcome on unchanged code is.

A test that failed once with no prior flips is not yet flaky — keep tracking
it, don't quarantine on a single data point.

## Step 3 — Rank and select quarantine candidates

Sort all tracked tests by flakiness score. Select every test at or above
`{{quarantine_threshold}}` that isn't already marked quarantined in the
ledger.

## Step 4 — Apply the quarantine (skip, never delete)

For each selected test, add a framework-appropriate skip marker with a reason
and a link to the tracking issue — adapt to the project's actual test
framework:

```js
// Jest / Vitest
it.skip('does the thing', () => { ... }); // FLAKY: quarantined <date>, see #<issue>
```

```python
# Pytest
@pytest.mark.skip(reason="FLAKY: quarantined <date>, see #<issue>")
def test_does_the_thing(): ...
```

```go
// Go
func TestDoesTheThing(t *testing.T) {
    t.Skip("FLAKY: quarantined <date>, see #<issue>")
    ...
}
```

Never remove the test body, its assertions, or the file. The quarantine is
reversible by construction — deleting the skip marker restores the test.

## Step 5 — Open one quarantine PR

```sh
BRANCH="test/quarantine-$(date +%Y-%m-%d)"
git checkout -b "$BRANCH" origin/main
git add -p   # stage only the skip-marker changes
git commit -m "test(quarantine): skip $(date +%Y-%m-%d) flaky tests"
git push origin "$BRANCH"

gh pr create --repo {{target_repo}} --base main --head "$BRANCH" \
  --title "test(quarantine): skip flaky tests ($(date +%Y-%m-%d))" \
  --label flaky-test \
  --body "Quarantines the tests below at or above the flakiness threshold.
Each is skipped, not deleted, with a link to run evidence. See tracking issue
#<issue-number>. A human owns the merge and the eventual de-quarantine."
```

One PR per run; if a PR from this run's branch already exists, push
additional commits to it instead of opening a second one.

## Step 6 — File or update the tracking issue

Keep exactly one open, running issue titled `Flaky test quarantine tracker`.
Create it if it doesn't exist; otherwise edit its body to the current state:

```sh
gh issue create --repo {{target_repo}} \
  --title "Flaky test quarantine tracker" \
  --label flaky-test \
  --body "<table: test, file, flakiness score, quarantined since, PR>"
# or, if it already exists:
gh issue edit <ISSUE_NUMBER> --repo {{target_repo}} --body "<updated table>"
```

The table lists every currently quarantined test, its score, when it was
quarantined, and the PR that quarantined it — plus a section for tests that
have been stable long enough in the ledger to be considered for
de-quarantine.

## Step 7 — Post the Slack summary

Post to `{{alert_channel}}`: how many tests newly crossed the threshold this
run, how many remain quarantined from before, and any tests stable enough to
recommend de-quarantining — with links to the PR and the tracking issue.
Never post raw run logs or the full ledger to Slack.

## Step 8 — Update the ledger

Append/update `.kortix/memory/flaky-test-ledger.md` (see `<ledger-format>`),
then open and self-merge a scoped change request for the ledger update only.

</workflow>

<ledger-format>
Lives at `.kortix/memory/flaky-test-ledger.md`. Tracks, per test
(`file::test_name`): the last processed `run_id` (so history isn't re-scored),
a rolling outcome history (run_id, head_sha, outcome), the current flip count,
failure rate, and flakiness score, quarantine status (not-flagged / watching /
quarantined), the quarantine PR link and date if quarantined, the
tracking-issue link, and a **stable-candidates** section for quarantined tests
whose recent runs are clean and could be de-quarantined.
</ledger-format>

<guardrails>
- **Skip, never delete.** The agent's only edit to a test file is a
  skip/quarantine marker with a reason; it never removes a test, an
  assertion, or a file.
- **No direct push to `main`.** The agent opens a PR and stops. A human
  reviews and merges.
- **One PR per run, one running tracking issue.** Extend the existing PR/issue
  rather than opening duplicates.
- **Evidence-based scoring only.** A single failure is not flakiness; the
  score comes from the ledger's multi-run history of flips.
- **Secrets scoped.** The GitHub connector and `GH_TOKEN` are injected at
  runtime by the Secrets Manager; never written to disk, logs, or the Slack
  summary.
- **Slack gets a summary, not raw data.** Run logs and the full ledger never
  leave the sandbox; only the PR, the issue, and a short summary do.
- **Never touch CI config to force a pass.** The agent quarantines the test,
  not the signal — it never disables a whole suite, retries-until-green, or
  edits CI workflow files to hide a failure.
</guardrails>

</skill>
