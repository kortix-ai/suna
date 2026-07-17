---
name: pipeline-hygiene-rules
description: Daily HubSpot pipeline-hygiene rules — staleness, missing next step/close date, stage stalls, and overdue tasks — plus how to nudge the owning rep in Slack and escalate the day's worst offenders to the sales manager. The only write is an internal hygiene flag; stage, owner, and amount are never touched.
---

<skill name="pipeline-hygiene-rules">

<overview>
Turn four hygiene checks into a same-day nudge instead of a finding buried in
next week's pipeline review. A daily cron spawns a fresh session with
read-mostly access to HubSpot; this skill pulls every open deal, scores it
against the four rules, nudges the owning rep in Slack, and escalates the
day's worst offenders to the sales manager. Every run recomputes from
HubSpot's current state — there is no carryover between days.
</overview>

<when-to-load>
- The daily cron fires the pipeline-hygiene scan.
- A human asks the agent to check pipeline hygiene or explain why a specific
  deal was flagged.
</when-to-load>

<workflow>

## Step 1 — Pull every open deal (read-only)

Pull all open deals: current stage, amount, close date, next step field, and
how long the deal has sat in its current stage (time-in-stage). Read-only —
no field on the deal is changed in this step.

## Step 2 — Pull activities per deal (read-only)

Pull logged calls, emails, meetings, and notes per deal, with timestamps.
This is the basis for the staleness check in Step 4.

## Step 3 — Pull tasks per deal (read-only)

Pull open tasks tied to each deal, with due dates. A task past its due date
with no completion is overdue.

## Step 4 — Apply the four hygiene rules

Evaluate every open deal against all four independently — a deal can trip
more than one:

| Rule | Trip condition |
|---|---|
| Stale | No logged activity (call, email, meeting, note) in the last {{stale_days}} days |
| Incomplete | Missing next step, missing close date, or both |
| Stalled | No stage change in the last {{stall_days}} days |
| Overdue task | At least one open task past its due date |

## Step 5 — Write the hygiene flag (the only write)

For every deal that trips at least one rule, write the internal hygiene-flag
field on the deal noting which rule(s) tripped and the date. This is the
**only** field the agent ever writes — never the stage, the owner, or the
amount. Deals that trip no rule get their flag cleared if previously set.

## Step 6 — Nudge the owning rep in Slack

For each flagged deal, send the owning rep a Slack nudge naming the deal,
which rule(s) tripped, and the concrete action needed:

| Rule tripped | Nudge action |
|---|---|
| Stale | Log the last touchpoint or make contact today |
| Incomplete | Set the missing next step and/or close date |
| Stalled | Move the deal forward or note why it hasn't |
| Overdue task | Complete or reschedule the task |

Group multiple flagged deals for the same rep into one message rather than
one message per deal.

## Step 7 — Escalate the day's worst to {{escalation_channel}}

After all rep nudges are sent, rank flagged deals by:

1. Number of rules tripped at once (most rules first).
2. Deal amount at risk (largest first, as a tiebreaker).
3. Days since last activity (longest first, as a second tiebreaker).

Post the top offenders to {{escalation_channel}} in one message: deal name,
owning rep, amount, which rules tripped, and days since last activity. Post
exactly once per run.

</workflow>

<guardrails>
- **Read-mostly.** Deals, stage history, activities, and tasks are read-only.
  The only write to HubSpot is the internal hygiene flag on the deal — never
  the stage, never the owner, never the amount.
- **No memory between runs.** Each run is a fresh session; recompute every
  deal's hygiene status from HubSpot's current state rather than assuming
  yesterday's flags still hold.
- **Nudge and flag only.** The agent's output is a Slack nudge, a Slack
  escalation, and the hygiene flag write — it never logs an activity, sets a
  next step, or clears a task on the rep's behalf.
- **Scoped secrets.** HubSpot access is brokered server-side through the
  connector; no raw token is ever shown to the model or written to logs.
- **People decide, not the agent.** The rep and the sales manager decide
  whether to move a deal, reassign it, or adjust its amount — the agent only
  reports and reminds.
</guardrails>

</skill>
