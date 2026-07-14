---
name: pr-qa
description: Per-PR QA runbook for {{target_repo}}. Checks out the branch, runs the full verification suite, deploys the change to the test environment, exercises it through Cloudflare, and posts a pass/fail result as a GitHub check and comment. Test environment only — no production access, no merge.
---

<skill name="pr-qa">

<overview>
QA every PR the moment it opens or changes, not just when a human gets to
review it. Each PR revision gets its own fresh sandbox session seeded with the
branch: install clean, run the full suite, deploy an ephemeral instance of the
change to the test environment, exercise the new behavior end-to-end, and
re-check the result through the Cloudflare edge in front of it. The result —
pass or fail, with evidence — posts back to the PR as a check and comment.
Nothing else leaves the sandbox.

Reactive and PR-driven: one independent run per PR revision, no state carried
between sessions except a shared list of edge cases worth re-checking.
</overview>

<when-to-load>
- The cadence sweep finds a PR opened or pushed to since the last check.
- A human asks the agent to QA a specific PR or branch.
- A PR's checks need to be re-run after a force-push or a base-branch change.
</when-to-load>

<workflow>

## Step 0 — Orient

```sh
# Read the known-issues memory before touching the branch — edge cases that
# have bitten before, flows that are critical, flaky tests already on file.
cat .kortix/memory/qa-known-issues.md 2>/dev/null || echo "(no known issues yet)"

# Confirm this PR revision hasn't already been QA'd.
gh pr view --repo {{target_repo}} <PR_NUMBER> --json headRefOid,statusCheckRollup
```

If the current head SHA already carries a `qa-agent` check from this agent,
skip it — don't re-run against a revision you've already reported on.

## Step 1 — Check out the branch clean

```sh
git clone --filter=blob:none https://github.com/{{target_repo}}.git /workspace/pr
cd /workspace/pr
gh pr checkout <PR_NUMBER>
<install command for the stack>   # e.g. pnpm install --frozen-lockfile / npm ci / pip install -r requirements.txt
```

One clone per PR revision, in this session's own sandbox — nothing reused from
a prior PR's checkout.

## Step 2 — Run the full suite

```sh
cd /workspace/pr
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
curl -sI https://<cloudflare-fronted-test-host>/<changed-path>   # routing, headers, caching, redirects
```

A route that works direct-to-origin but breaks through Cloudflare (a caching
rule, a redirect, a header transform) is a QA failure, not a pass.

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

## Step 7 — Tear down and record

```sh
<teardown command for the ephemeral test deploy>
```

Tear down the ephemeral deploy so it doesn't linger. If this run surfaced a
genuinely new edge case (not already in the memory file) — a bug that would've
reached staging, a flow no prior run checked — append it to
`.kortix/memory/qa-known-issues.md` with the PR link and a one-line
description, so the next PR's session checks for it too.

</workflow>

<guardrails>
- **Test environment only.** Every deploy and every exercise runs against the
  test environment. No production credential, no production deploy, no
  production data — ever, even to confirm a fix.
- **Never merge, never push to `main`.** The agent posts a check and a
  comment; a human owns the merge decision entirely.
- **Sandbox isolation.** The checkout, install, suite run, and deploy all
  happen in this session's disposable sandbox. Only the check + comment leave
  it.
- **Scoped, brokered secrets.** GitHub, test-environment, and Cloudflare
  credentials are injected at runtime by the Secrets Manager — never visible
  to the model, never written to a log or a comment.
- **One result per revision.** Don't re-post for a head SHA already checked;
  re-run only on a genuine new push.
- **No silent retries.** A flaky test is reported as flaky with evidence,
  never quietly re-run until it happens to pass.
- **Ephemeral by default.** Every test deploy is torn down at the end of the
  run; nothing from a PR's test instance is left running.
</guardrails>

</skill>
