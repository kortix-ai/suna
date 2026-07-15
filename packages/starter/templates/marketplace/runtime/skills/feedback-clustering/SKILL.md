---
name: feedback-clustering
description: Turns feedback from Plain, public reviews, and a Slack channel into deduplicated, quantified themes, and reconciles each theme against one Linear issue in {{linear_team}} — never prioritizing, assigning, or closing.
---

<skill name="feedback-clustering">

<overview>
Feedback about the same underlying request shows up worded differently in
Plain support threads, public reviews, and a Slack channel, and never gets
counted together. This skill turns a run's raw feedback into themes —
deduplicated, quantified, and backed by real quotes — and reconciles each
theme against exactly one Linear issue in {{linear_team}}, so a request a
hundred people made looks different from a one-off.

Fresh session each run. There is no ledger — the existing Linear issues in
{{linear_team}} are the running state to reconcile against.
</overview>

<when-to-load>
- The scheduled cron fires the feedback sweep.
- A human asks for the current feedback themes, or why a piece of feedback did
  or didn't land in a given theme.
</when-to-load>

<workflow>

## Step 1 — Read the existing themes in Linear first

Before touching any source, pull the current state of {{linear_team}} so new
feedback is reconciled, not duplicated:

- List open issues in {{linear_team}}, with their title, description, and
  current quote/count body.
- Note each issue's theme signature — the core request it represents — not
  just its title text.

## Step 2 — Gather support threads from Plain (read-only)

Pull recent threads (since the last run's approximate window, or the last
24–48h if that's unknown). For each thread, extract:

- The specific request or complaint, in the user's own words.
- A candidate quote — the clearest single sentence expressing it.
- Enough context (account, thread link) to trace it back later.

Ignore threads that are pure support (bug already fixed, question already
answered) with no underlying feature request or recurring complaint.

## Step 3 — Gather public reviews (read-only)

Fetch the current reviews from {{review_sources}} (G2, app-store listings, or
whatever is configured). For each new review since the last visible one:

- Extract the specific ask or complaint, not star-rating alone.
- Take the reviewer's own phrase as the candidate quote.
- Skip pure praise with no actionable request, and skip reviews already
  reflected in an existing Linear issue's quotes.

## Step 4 — Gather messages from the feedback channel (read-only)

Read {{feedback_channel}} for messages where a team member is relaying
something they heard from a user (not internal chatter). Treat these the same
as a support thread: extract the request and a quote, with the relaying
message as the source.

## Step 5 — Cluster into themes

Group everything gathered in Steps 2–4 into themes. Two mentions are the
**same theme** when they ask for the same underlying capability or fix, even
if:

- The wording is completely different ("can't bulk export" vs. "no way to
  download everything at once").
- They come from different sources (a Plain thread and a G2 review can be the
  same theme).
- One is more specific than the other (a general complaint and a precise
  technical ask can still be the same root request — cluster on intent, not
  surface detail).

Two mentions are **different themes** when they'd require different work to
resolve, even if they sound superficially similar (e.g. "slow page load" on
the dashboard vs. "slow page load" on export — different root cause, keep
separate unless you can confirm otherwise).

## Step 6 — Pick the representative quote and title

For each theme:

- **Quote** — the clearest, most specific verbatim quote from any mention in
  the theme. Prefer a quote that names the concrete capability over a vaguer
  one.
- **Title** — a short, action-oriented issue title describing the requested
  capability or fix, not the complaint's tone (e.g. "Bulk export for
  workspace data", not "Users are annoyed about exporting").

## Step 7 — Reconcile against Linear

For each theme from Step 5:

- **Matches an existing issue** (same theme signature from Step 1): add the
  new quote(s) to its quote list, increment its mention count, and note the
  new source(s). Don't create a duplicate.
- **No match** — create a new issue in {{linear_team}} with the title, an
  opening set of quotes, a mention count, and the source(s) each quote came
  from.

Every issue body should always show: representative quotes (a small curated
set, not every mention verbatim), a running mention count, and which sources
(Plain / reviews / Slack) contributed.

## Step 8 — Stop

Report the set of Linear issues created or updated this run. Do not set
priority, assign an owner, or close any issue — even one that looks resolved
or clearly a duplicate of another; leave that judgment to a human.

</workflow>

<guardrails>
- **Read-only sources.** Plain, the review sources, and {{feedback_channel}}
  are read-only. The only write in this skill is creating or updating a
  Linear issue.
- **One issue per theme.** Never file a second issue for a theme that already
  has one — reconcile against Step 1's list first, every run.
- **People decide priority.** The agent never sets priority, assigns an
  owner, or closes an issue. It quantifies and describes; humans weigh themes
  against the roadmap.
- **Quotes over volume.** Keep a curated set of representative quotes per
  issue, not an ever-growing dump of every mention.
- **Scoped secrets.** Plain, review-source, Slack, and Linear access is
  brokered server-side; no raw credential is ever shown to the model or
  written to logs.
- **No memory between runs.** Each run is a fresh session; the current state
  of {{linear_team}} in Linear is the only carryover, not an internal ledger.
</guardrails>

</skill>
