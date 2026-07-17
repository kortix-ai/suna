---
name: pr-review-sla
description: Daily PR review SLA sweep for {{target_repos}}. Flags PRs awaiting review past {{review_sla_hours}}h, stale PRs with no activity in {{stale_days}}d, and PRs sitting on unaddressed requested changes, then nudges the author or reviewer in {{alert_channel}} with what's blocking. Read-only against GitHub — never merges, closes, or approves.
---

<skill name="pr-review-sla">

<overview>
Catch a stalled PR the morning it stalls, not the week someone notices. A
daily cron spawns a fresh session with read-only access to GitHub through the
`gh` CLI; this skill pulls every open PR across `{{target_repos}}` and checks
each one against three independent rules — overdue for first review, stale
with no activity, and carrying requested changes the author hasn't addressed —
then nudges whoever owns the next move in {{alert_channel}}.

Proactive and schedule-driven; recomputes from GitHub's current state every
run, with no memory of the prior day's nudges.
</overview>

<when-to-load>
- The daily cron fires the PR review sweep.
- A human asks which PRs are overdue for review, stale, or blocked on
  unaddressed feedback.
</when-to-load>

<workflow>

## Step 0 — Orient

```sh
# List every open PR across the configured repos.
gh pr list --repo {{target_repos}} --state open \
  --json number,title,url,author,createdAt,updatedAt,reviewRequests,reviews,comments,commits
```

Fresh session, no ledger — recompute everything from this pull. Repeat per
repo if `{{target_repos}}` names more than one.

## Step 1 — Pull the review detail per PR

```sh
gh pr view --repo {{target_repos}} <PR_NUMBER> \
  --json number,title,url,author,createdAt,updatedAt,reviewRequests,reviews,comments,commits
```

`reviews` gives each review's state (`APPROVED`, `CHANGES_REQUESTED`,
`COMMENTED`) and timestamp; `commits` and `comments` give the last activity;
`reviewRequests` gives who's currently asked to review.

## Step 2 — Flag PRs awaiting review past the SLA

For each PR with an outstanding `reviewRequests` entry and no `APPROVED` or
`CHANGES_REQUESTED` review from that reviewer since the request:

```
hours_waiting = now - max(createdAt, last review-request timestamp)
```

Flag if `hours_waiting > {{review_sla_hours}}`. Nudge target: the requested
reviewer(s).

## Step 3 — Flag stale PRs

For every open PR, take the most recent of: last commit, last comment, last
review.

```
days_idle = now - max(last_commit, last_comment, last_review)
```

Flag if `days_idle > {{stale_days}}`. Nudge target: the author. A PR already
flagged in Step 2 can also be flagged here if it independently qualifies — the
two checks are separate signals, not mutually exclusive.

## Step 4 — Flag unaddressed requested changes

For each PR whose most recent review is `CHANGES_REQUESTED`, check whether the
author has pushed a commit or posted a comment since that review's timestamp.
If not, flag it. Nudge target: the author.

| Check | Passes (no nudge) | Fails (nudge) |
|---|---|---|
| Overdue review | Reviewer submitted within SLA | No review after {{review_sla_hours}}h |
| Stale | Any activity within the window | No activity for {{stale_days}}d |
| Unaddressed changes | Author pushed/replied after the review | Silence since `CHANGES_REQUESTED` |

## Step 5 — Write the nudge

For every PR that trips at least one rule, write one line: the PR title and
link, which rule(s) it tripped, and how long it's been in that state, e.g.
"Awaiting review 3d (SLA 24h) — @reviewer" or "Stale 6d, no activity — @author"
or "Changes requested 4d ago, not yet addressed — @author". A PR that trips
more than one rule gets one entry listing all of them, not a duplicate nudge
per rule.

## Step 6 — Post to Slack

Post exactly one summary message to {{alert_channel}} for the whole sweep,
grouped by rule (overdue for review / stale / unaddressed changes), each entry
tagging the person it's nudging. This is a fresh session — there is no prior
list to diff against, so the whole sweep is recomputed and reposted every day.

</workflow>

<guardrails>
- **Read-only, always.** Every GitHub call is a read (`gh pr list`, `gh pr
  view`, `gh api` GET). Never merge, close, approve, or dismiss a review, even
  if `GH_TOKEN` would technically allow it.
- **One output.** The Slack post to {{alert_channel}} is the only thing that
  leaves the sandbox. No PR comments, no direct messages, no GitHub writes.
- **No memory between runs.** Each run is a fresh session; recompute every
  PR's state from GitHub rather than assuming anything from the prior day's
  nudges.
- **Scoped secret.** `GH_TOKEN` is injected as an environment variable at
  runtime, scoped to read access, and never shown to the model or written to
  logs.
- **People decide, not the agent.** The nudge flags what's blocking; a human
  reviews, pings, or closes the PR themselves.
</guardrails>

</skill>
