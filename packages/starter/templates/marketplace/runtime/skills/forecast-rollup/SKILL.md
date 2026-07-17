---
name: forecast-rollup
description: Weekly HubSpot pipeline-to-forecast rollup — weights every open deal by its own HubSpot stage probability, rolls the total up by stage, rep, and segment ({{segment_property}}) against {{quarterly_quota}}, and flags deals slipping the quarter and other forecast risk before posting to {{forecast_channel}}. Read-only; never changes a deal's amount, close date, stage, or owner.
---

<skill name="forecast-rollup">

<overview>
Turn HubSpot's open pipeline into a real weekly forecast instead of a
spreadsheet rebuilt the day before the call. A weekly cron spawns a fresh
session with read-only access to HubSpot; this skill weights every open deal
by the probability HubSpot already has configured on its own stage, rolls the
weighted total up by stage, rep, and segment, compares it to quota, and calls
out the deals that put the number at risk.

Proactive and read-only; every run recomputes the whole quarter's forecast
from HubSpot's current state — there is no carryover between weeks.
</overview>

<when-to-load>
- The weekly cron fires the sales-forecast rollup.
- A human asks for the current forecast, or why a specific deal was flagged
  as slipping or at risk.
</when-to-load>

<workflow>

## Step 1 — Pull every open deal (read-only)

Via the HubSpot connector, pull every deal not in a closed-won or closed-lost
stage: amount, dealstage, close date, owner (rep), pipeline, and the
{{segment_property}} property used for the segment rollup. Also pull deals
that closed won so far this quarter — they count toward the forecast at full
value.

## Step 2 — Pull each stage's own probability (read-only)

Pull the pipeline/stage configuration from HubSpot — every stage already
carries a win-probability weight the team itself configured. Use that weight
directly. Never hardcode or assume a probability; a team's own calibration of
its stages is the whole point of weighting by stage.

## Step 3 — Determine the current quarter window

Compute the current calendar quarter's start and end from today's date. An
open deal counts toward this quarter's forecast if its close date falls
inside that window; a closed-won deal counts if it closed inside the window.

## Step 4 — Weight and roll up

For every in-quarter open deal: `weighted_amount = amount × stage_probability`.
Total forecast = sum of this quarter's closed-won amounts (already in the
bag) + sum of weighted amounts across this quarter's open deals. Roll that
same weighted total up three ways:

- **By stage** — weighted amount per stage, so the team sees where the
  forecast is concentrated.
- **By rep** — weighted amount per deal owner, so each rep's forecasted
  contribution is visible against their own book.
- **By segment** — weighted amount per {{segment_property}} value.

## Step 5 — Compare to quota

`attainment = total_forecast / {{quarterly_quota}}`. Report the total
forecast, the quota, the attainment percentage, and the dollar gap (positive
or negative) alongside the breakdown from Step 4.

## Step 6 — Flag deals slipping the quarter

A deal is **slipping** when either is true:

| Condition | Why it's slipping |
|---|---|
| Close date already in the past, deal still open | The date has already come and gone without closing — it will push into next quarter (or later) unless the rep updates it |
| Close date inside this quarter, but the deal's current stage is early/mid and there isn't enough runway left in the quarter to realistically move through the remaining stages | The date on file isn't credible given where the deal actually sits |

List every slipping deal with its owner, amount, stage, and close date.

## Step 7 — Flag other forecast risk

Independently of Step 6, flag a deal as **at risk** when it is large relative
to the rest of the in-quarter pipeline (e.g. well above the median in-quarter
deal size) and shows either:

- No logged activity in a while relative to the deal's stage and size, or
- No stage movement for a length of time that's long relative to how long
  deals normally sit in that stage.

A deal can be both slipping and at risk; list it under both if so.

## Step 8 — Post the forecast

Post one message to {{forecast_channel}}: the total weighted forecast vs
{{quarterly_quota}} with attainment percentage, the breakdown by stage, by
rep, and by segment, the list of slipping deals, and the list of other
at-risk deals. Post exactly once per run — this is a fresh session, so there
is no prior forecast to diff against; the whole thing is recomputed and
reposted every week.

</workflow>

<guardrails>
- **Read-only, always.** The HubSpot connector is read-only. Never write to a
  deal's amount, close date, stage, or owner, even if the credential would
  technically allow it.
- **One output.** The Slack post to {{forecast_channel}} is the only thing
  that leaves the sandbox. No edits to HubSpot, no direct messages to reps.
- **No memory between runs.** Each run is a fresh session; recompute the
  quarter's forecast from HubSpot's current state rather than assuming
  anything from the prior week's post.
- **Weight from HubSpot's own configuration.** Stage probabilities come from
  the team's own pipeline setup in HubSpot, never a hardcoded assumption.
- **Scoped secrets.** HubSpot access is brokered server-side through the
  connector; no raw credential is ever shown to the model or written to logs.
- **People decide, not the agent.** The forecast reports the number and flags
  the risk; reps and sales management decide what to do about any deal.
</guardrails>

</skill>
