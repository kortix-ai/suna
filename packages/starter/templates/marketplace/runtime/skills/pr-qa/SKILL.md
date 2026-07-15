---
name: pr-qa
description: Persistent-session, per-sweep QA runbook for {{target_repo}}. Discovers PRs since the last check, then for each one checks out the branch, runs the full verification suite, deploys the change to the test environment, exercises it through the edge, and posts a pass/fail result as a GitHub check and comment. Test environment only — no production access, no merge.
---

<skill name="pr-qa">

<overview>
QA every PR the moment a sweep finds it, not just when a human gets to review
it. This is a single persistent session (`session_mode: reuse`) re-prompted on
a schedule: each sweep discovers PRs opened or pushed since the last check,
then gives each one its own clean, isolated checkout inside this session —
install clean, run the full suite, deploy an ephemeral instance of the change
to the test environment, exercise the new behavior end-to-end, and re-check
the result through the edge in front of it. The result — pass or fail, with
evidence — posts back to the PR as a check and comment. Nothing else leaves
the sandbox except a durable, committed record of new edge cases worth
re-checking next time.

Proactive and schedule-driven: one independent QA pass per PR revision found in
a sweep, handled as its own unit so a failure on one never blocks the others.
The only state carried forward on purpose is the landed edge-case ledger — an
in-sandbox file alone doesn't survive on its own.
</overview>

<when-to-load>
- The cadence sweep finds a PR opened or pushed to since the last check.
- A human asks the agent to QA a specific PR or branch.
- A PR's checks need to be re-run after a force-push or a base-branch change.
</when-to-load>

<workflow>

## Step 0 — Discover and orient

```sh
# Read the known-issues ledger before touching any branch — edge cases that
# have bitten before, flows that are critical, flaky tests already on file.
cat .kortix/memory/qa-known-issues.md 2>/dev/null || echo "(no known issues yet)"

# Discover every PR opened or pushed to since the last sweep.
gh pr list --repo {{target_repo}} --state open \
  --json number,headRefOid,statusCheckRollup,updatedAt
```

Filter out any PR whose current `headRefOid` already carries a `qa-agent`
check in `statusCheckRollup` — don't re-run against a revision you've already
reported on. Work through what's left one PR at a time, each as its own
independent unit: a failure on one PR is a self-contained result and never
blocks or contaminates QA of the others in this sweep.

For each remaining PR, confirm before checkout:

```sh
gh pr view --repo {{target_repo}} <PR_NUMBER> --json headRefOid,statusCheckRollup
```

## Step 1 — Check out the branch clean

```sh
rm -rf /workspace/pr-<PR_NUMBER>
git clone --filter=blob:none https://github.com/{{target_repo}}.git /workspace/pr-<PR_NUMBER>
cd /workspace/pr-<PR_NUMBER>
gh pr checkout <PR_NUMBER>
<install command for the stack>   # e.g. pnpm install --frozen-lockfile / npm ci / pip install -r requirements.txt
```

One clean clone per PR revision, keyed by PR number. This session persists
across sweeps, so remove any stale checkout for this PR number first — never
reuse a prior revision's working tree, and never let one PR's checkout leak
into another's.

## Step 2 — Run the full suite

```sh
cd /workspace/pr-<PR_NUMBER>
<unit test command>        2>&1 | tee /tmp/qa-unit.log
<integration test command> 2>&1 | tee /tmp/qa-integration.log
<e2e test command>          2>&1 | tee /tmp/qa-e2e.log
```

Capture full failure output — stack trace, failing assertion, the exact
command — not just a pass/fail count. Cross-reference `qa-known-issues.md` for
flows that have broken before and confirm this run actually exercised them.

## Step 3 — Deploy the change to the test environment

```sh
<deploy command, e.g. an internal deploy script / flyctl / vercel> \
  --env test --ref <PR head SHA>
```

Stand up an ephemeral instance of exactly this branch. Wait for the deploy to
report healthy before exercising anything against it — a QA run against a
half-started deploy is a fail, not a skip.

## Step 4 — Exercise the change end-to-end

Hit the new or changed behavior directly against the deployed instance — the
actual endpoint, page, or flow the PR touches — not just localhost:

```sh
curl -sf https://<test-deploy-host>/<changed-path> -o /tmp/qa-response.json
```

Then repeat the critical checks through the edge:

```sh
curl -sI https://<edge-fronted-test-host>/<changed-path>   # routing, headers, caching, redirects
```

This is a plain, unauthenticated request against the public HTTPS host — no
edge-provider credential or connector is needed for it. A route that works
direct-to-origin but breaks through the edge (a caching rule, a redirect, a
header transform) is a QA failure, not a pass.

## Step 5 — Decide pass or fail

| Result | Criteria |
|---|---|
| **Pass** | Suite green, deploy healthy, exercised behavior matches expectation, edge checks clean |
| **Fail** | Any suite failure, a failed or unhealthy deploy, exercised behavior wrong, or an edge-only regression |
| **Flag as flaky** | A test fails, then passes on an isolated re-run with no code change — report it as flaky with both runs' logs; don't just retry until it's green |

## Step 6 — Post the result

```sh
gh api repos/{{target_repo}}/statuses/<PR_head_SHA> \
  -f state=<success|failure> -f context="qa-agent" -f description="<one-line result>"
gh pr comment --repo {{target_repo}} <PR_NUMBER> --body "<pass/fail summary>"
```

Pass: a short green summary — suite results, what was exercised, edge checks
run. Fail: the failing command, the full log excerpt, and exact steps to
reproduce against the test deploy. Exactly one result comment per PR revision.

## Step 7 — Tear down and land the ledger update

```sh
<teardown command for the ephemeral test deploy>
```

Tear down the ephemeral deploy for this PR so it doesn't linger — the
session's own sandbox stays up for the next sweep; only the test-environment
deploy is disposable.

If this run surfaced a genuinely new edge case (not already in the ledger) — a
bug that would've reached staging, a flow no prior run checked — append it to
`.kortix/memory/qa-known-issues.md` with the PR link and a one-line
description, then land it durably:

```sh
git add .kortix/memory/qa-known-issues.md
git commit -m "docs(qa): record edge case from PR #<PR_NUMBER>"
```

Open (and self-merge) a scoped change request for just this ledger update via
the `project.cr.open` action — an edit that only lives in the sandbox never
survives on its own; only a landed change request does. Then move to the next
PR in this sweep's batch, if any, with a clean checkout (Step 1).

</workflow>

<guardrails>
- **Test environment only.** Every deploy and every exercise runs against the
  test environment. No production credential, no production deploy, no
  production data — ever, even to confirm a fix.
- **Never merge, never push to `main`.** The agent posts a check and a
  comment; a human owns the merge decision entirely.
- **Per-PR isolation, persistent session.** Each PR gets its own clean clone
  and branch checkout inside `/workspace/pr-<PR_NUMBER>`; nothing from one
  PR's working tree leaks into another's. The session itself persists across
  sweeps so the ledger and known-issues memory survive — only the check +
  comment, and the landed ledger change request, ever leave the sandbox;
  ephemeral test deploys are always torn down per PR.
- **Scoped, brokered secrets.** GitHub and test-environment credentials are
  injected at runtime by the Secrets Manager — never visible to the model,
  never written to a log or a comment. The edge re-check is an unauthenticated
  public HTTPS request; no separate credential is needed for it.
- **Ledger changes only through a change request.** Updates to
  `.kortix/memory/qa-known-issues.md` land via a scoped `project.cr.open`
  change request for just that file — never bundled with anything else.
- **One result per revision.** Don't re-post for a head SHA already checked;
  re-run only on a genuine new push.
- **No silent retries.** A flaky test is reported as flaky with evidence,
  never quietly re-run until it happens to pass.
- **Ephemeral by default.** Every test deploy is torn down at the end of the
  run; nothing from a PR's test instance is left running.
</guardrails>

</skill>
