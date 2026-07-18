---
name: ad-performance-review
description: Daily read-only ad-performance runbook — budget pacing, CPA/ROAS drift, underperforming ads and keywords, and anomaly detection across Google Ads and Meta Ads, plus how to rank and word optimization recommendations for {{alert_channel}}.
---

<skill name="ad-performance-review">

<overview>
Turn raw daily spend and performance numbers from Google Ads and Meta Ads into
a ranked list of findings and optimization recommendations. A daily cron
spawns a fresh session with read-only access to both platforms; this skill
turns those numbers into pacing checks, drift signals, underperformer flags,
and anomaly detection, then a specific recommended action for each. The agent
never acts on its own findings — every recommendation is for a human to
execute.
</overview>

<when-to-load>
- The daily cron fires the ad-performance scan.
- A human asks for the current state of a campaign, or why a recommendation
  was made.
</when-to-load>

<workflow>

## Step 1 — Pull spend and performance from Google Ads (read-only)

For every active campaign, ad group, ad, and keyword, pull: daily spend,
monthly budget, clicks, impressions, conversions, cost per acquisition (CPA),
and return on ad spend (ROAS) where conversion value is tracked. Pull the
trailing 30-day baseline for the same metrics.

## Step 2 — Pull spend and performance from Meta Ads (read-only)

For every active campaign, ad set, and ad across Facebook and Instagram
placements, pull the same fields: daily spend, budget, clicks, impressions,
conversions, CPA, and ROAS, plus the trailing 30-day baseline.

## Step 3 — Check budget pacing

For each campaign, compare spend-to-date against the elapsed fraction of its
budget period.

| Pacing signal | Criteria |
|---|---|
| On pace | Spend-to-date within ±15% of the expected linear pace |
| Overpacing | Spend-to-date more than 15% ahead of expected pace — will exhaust budget early |
| Underpacing | Spend-to-date more than 20% behind expected pace — budget is going unused |

## Step 4 — Check CPA/ROAS drift

Compare each campaign's/ad's trailing 7-day CPA and ROAS against its 30-day
baseline.

| Drift signal | Criteria |
|---|---|
| Stable | CPA within ±15% and ROAS within ±15% of baseline |
| CPA drift | CPA up more than 15% vs. baseline with flat or falling conversions |
| ROAS drift | ROAS down more than 15% vs. baseline |
| Compounding drift | CPA up AND ROAS down in the same window — flag first |

## Step 5 — Flag underperforming ads and keywords

| Underperformer signal | Criteria |
|---|---|
| Low-CTR ad | Click-through rate less than half the ad set's/ad group's average, with 1,000+ impressions |
| High-cost, no-convert keyword/ad | Spend above the account's median per-unit spend with zero conversions over the trailing window |
| Wasted-spend keyword | Search term with 3+ clicks and zero conversions over 14+ days (Google Ads search terms report) |

## Step 6 — Detect anomalies

Flag anything that breaks the normal pattern rather than drifting gradually:

- A single day's spend more than 2x the campaign's trailing 7-day daily average.
- A sudden CTR drop of more than 50% day-over-day on a previously stable ad.
- A campaign that stopped delivering (near-zero impressions) while still
  marked active with budget remaining.

## Step 7 — Draft the recommendation for each finding

Every finding gets exactly one concrete, human-actionable recommendation:

- Overpacing → suggest lowering the daily budget or adding a spend cap so it
  doesn't exhaust the period early.
- Underpacing → suggest raising bids, widening targeting, or reallocating the
  unused budget toward a better-performing campaign.
- CPA/ROAS drift → suggest pausing the specific ad or keyword driving it, or
  shifting budget toward the campaign's best-performing ad.
- Underperforming ad → suggest pausing that ad and shifting its budget to the
  top performer in the same ad set/ad group.
- Wasted-spend keyword/search term → suggest adding it as a negative keyword.
- Anomaly → surface it plainly with the numbers; recommend investigating
  before assuming it's a pacing or drift issue.

## Step 8 — Rank and post

Sort findings highest-impact first (compounding drift and overpacing that
risks exhausting budget rank above a single underperforming keyword). Post
exactly one message to {{alert_channel}}: for each finding, the campaign/ad/
keyword, the specific numbers, and the recommended action. Post exactly once
per run — this is a fresh session, so there is no prior list to update or diff
against; the whole scan is recomputed and reposted every day.

</workflow>

<guardrails>
- **Read-only, always.** Google Ads and Meta Ads are read-only connectors.
  Never write to either platform, even if the credential would technically
  allow it.
- **Recommend, never act.** Every finding carries a suggested action — pause,
  shift budget, add a negative keyword — but the agent never pauses a
  campaign, changes a budget, or edits an ad itself. That action stays with
  the marketing team.
- **One output.** The Slack post to {{alert_channel}} is the only thing that
  leaves the sandbox. No campaign changes, no bid changes, no budget edits.
- **No memory between runs.** Each run is a fresh session; recompute pacing,
  drift, and underperformers from the current state of both platforms rather
  than assuming anything from the prior day's list.
- **Scoped secrets.** Google Ads and Meta Ads access is brokered server-side
  through connectors. No raw credential is ever shown to the model or written
  to logs.
- **People decide, not the agent.** The list flags risk and suggests a next
  step; a human on the marketing team decides whether and how to act.
</guardrails>

</skill>
