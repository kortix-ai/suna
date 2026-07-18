---
name: win-loss-patterns
description: Weekly win-loss analysis for HubSpot closed deals. Reads deals closed-won and closed-lost in the trailing {{lookback_days}}-day window, breaks outcomes down by segment, competitor, price, and the stage lost deals die in, clusters close reasons into themes, and posts themes plus recommendations to {{alert_channel}}. Read-only and report-only — never writes to a HubSpot deal.
---

<skill name="win-loss-patterns">

<overview>
Turn a week of one-line HubSpot close reasons into a small number of real
themes with a recommendation attached to each. A weekly cron spawns a fresh
session with read-only access to HubSpot; this skill pulls every deal closed
in the trailing window, breaks the outcomes down four ways — segment,
competitor, price, and the stage where lost deals died — clusters the close
reasons into themes, and posts one summary to Slack.

Read-only and report-only: the agent never edits a deal and never contacts a
prospect. The output is a Slack message; a human decides what to change in the
playbook.
</overview>

<when-to-load>
- The weekly cron fires the win-loss analysis run.
- A human asks why deals are being won or lost, or for a win-loss breakdown.
</when-to-load>

<workflow>

## Step 1 — Pull the closed deals

Through the `hubspot` connector, read-only, pull every deal whose stage is
closed-won or closed-lost, with: close date, amount, segment/plan (or
company size if no segment field), the deal's stage-history,
`{{close_reason_property}}`, and `{{competitor_property}}`.

## Step 2 — Isolate the window

Using the close-date field, keep only deals closed in the last
{{lookback_days}} days. Because the session is fresh each run, this window is
derived entirely from HubSpot's own dates — there is no external ledger to
consult, and nothing carries over from the prior week.

## Step 3 — Compute the headline numbers

Count closed-won and closed-lost in the window, and the win rate
(`won / (won + lost)`). Compare total won amount to total lost amount (deal
value at risk, not just deal count).

## Step 4 — Break down by segment

Group by segment/plan/company-size band. For each segment, report win rate
and deal count. Flag any segment whose win rate is materially below the
overall rate — that's where the playbook is weakest.

## Step 5 — Break down by competitor

From `{{competitor_property}}`, group losses (and wins where a competitor was
named and we still won) by named competitor. For each competitor with enough
volume to matter, report the loss count and, where the close reason
mentions it, the reason we lost to them specifically (price, feature gap,
relationship, timing). Deals with no competitor recorded go in an
"unrecorded / no competitor" bucket — don't force a competitor name that
isn't there.

## Step 6 — Break down by price

Band deal amount (e.g. small / mid / large, using this account's own
distribution rather than fixed dollar cutoffs) and report win rate per band.
Note whether losses cluster at the high end (a pricing/negotiation problem) or
low end (a fit/qualification problem).

## Step 7 — Find where lost deals die

For closed-lost deals only, read the stage history and identify the stage the
deal was in immediately before it was marked lost. Rank stages by how many
lost deals died there. A stage that kills a disproportionate share of deals
relative to how many pass through it is a process problem, not just bad luck.

## Step 8 — Cluster close reasons into themes

Read `{{close_reason_property}}` across all closed-lost deals in the window
and group by what the rep meant, not exact wording — e.g. "lost on price,"
"missing feature," "competitor chosen," "champion left / no decision,"
"bad timing." For each theme, note the count and one representative
verbatim reason. If a reason field is blank, count it under "reason not
recorded" rather than guessing.

## Step 9 — Turn themes into recommendations

Pair every named theme (from segment, competitor, price, stage-of-death, or
close-reason clustering) with one concrete, actionable recommendation — e.g.
"three of five losses to Competitor X cited pricing on the enterprise tier;
consider a packaging review for that segment." A theme without a
recommendation doesn't make the post.

## Step 10 — Post the weekly summary

Post one message to {{alert_channel}}:

- Win rate and won/lost counts and value for the window, vs. what the window
  looked like the last time this much data closed.
- Breakdown by segment, by competitor, and by price band.
- The stage where lost deals most often die.
- The top themes, each with a count, a representative reason, and a
  recommendation.

Nothing else is written anywhere. No HubSpot record is modified, and no rep or
prospect is contacted.

</workflow>

<guardrails>
- **Read-only, always.** HubSpot is a read-only connector. Never edit a deal's
  stage, amount, close reason, or competitor field, even to fix an obviously
  blank or malformed one.
- **Report only, no action.** The agent never emails, messages, or otherwise
  contacts a rep or a lost prospect, and never opens a task on their behalf.
  Deciding what to do about a theme stays with people.
- **Single output.** The one weekly post to {{alert_channel}} is the only
  thing that leaves the sandbox.
- **No memory between runs.** Each run is a fresh session — the window,
  breakdowns, and themes are always recomputed from HubSpot's current state,
  not from a memory file, so there's nothing stale to carry forward or drift
  from.
- **Don't invent what isn't recorded.** A blank close reason or competitor
  field is reported as unrecorded, never guessed or filled in.
- **Scoped secrets.** HubSpot access is brokered server-side through the
  connector; no raw credential is ever shown to the model or written to logs.
</guardrails>

</skill>
