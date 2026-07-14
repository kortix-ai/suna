---
name: investor-update-draft
description: Monthly investor-update runbook. Reads last month's update from {{updates_folder}} for the prior numbers and the format to match, pulls MRR and revenue from Stripe and active accounts, growth, burn, and runway from Postgres, compares every metric to last month and to plan, and drafts this month's update as a new document — read-only across every connected system.
---

<skill name="investor-update-draft">

<overview>
Turn three read-only sources — Postgres, Stripe, and last month's update — into
one finished first draft. A monthly cron spawns a fresh session with no memory
of prior runs; this skill is what makes the draft consistent month over
month: which metrics to report, how each is defined, the plan targets to
compare against, and the exact section order and tone to match. The agent
never writes back to a source system — the new draft document is the only
thing it produces.
</overview>

<when-to-load>
- The monthly cron fires the investor-update draft.
- A human asks for this month's draft ahead of schedule, or asks why a
  specific metric moved.
</when-to-load>

<workflow>

## Step 1 — Read last month's update (read-only)

Open the most recent update in {{updates_folder}} and extract:

- Last month's figures for every metric this skill tracks (see Step 4).
- The section order, headings, and tone to reuse verbatim this month.
- Any plan targets or context it referenced (e.g. "Q-target MRR", "board-approved runway floor").

If {{updates_folder}} has no prior update yet, use the **Format** table below
as the default structure and note in the draft that this is the first run.

## Step 2 — Pull revenue metrics from Stripe (read-only)

Pull for the current calendar month:

| Metric | Definition |
|---|---|
| MRR | Sum of active subscription value, normalized to monthly |
| MRR growth | `(this month MRR − last month MRR) / last month MRR` |
| Revenue | Total collected revenue for the month |
| New / expansion / churned MRR | Movement components behind the net MRR delta |

## Step 3 — Pull product and finance metrics from Postgres (read-only)

Query for the current calendar month:

| Metric | Definition |
|---|---|
| Active accounts | Accounts with qualifying activity in the month |
| Account growth | Net new active accounts vs. last month |
| Burn | Net cash spent in the month (cash out − cash in, excluding financing) |
| Runway | Current cash balance ÷ trailing average monthly burn |

## Step 4 — Compare to last month and to plan

For every metric in Steps 2–3, compute both deltas:

- **Vs. last month** — absolute and percentage change from Step 1's figures.
- **Vs. plan** — variance against the plan target for this metric (from Step 1
  if it was recorded there, else from the plan targets held in memory/skill
  configuration for {{projectName}}).

Flag anything moving more than one plan-implied standard deviation, or any
metric moving in the wrong direction two months running, as a line the
narrative must address explicitly — don't bury a miss in a table.

## Step 5 — Write the narrative

Match last month's section order exactly. A typical structure:

1. **Headline** — one or two sentences on the month's overall trajectory.
2. **Metrics table** — MRR, growth, revenue, active accounts, burn, runway,
   each with last month and plan comparisons.
3. **What moved and why** — the flagged variances from Step 4, with the
   likely driver (a launch, a lost account, a pricing change, etc.) stated
   plainly rather than hedged.
4. **Asks / notable items** — anything the founder has flagged as needing
   investor visibility this month (hiring, fundraising, a specific ask).

Write the commentary as a draft for a founder to edit, not a finished
statement — flag genuine uncertainty (e.g. "likely driven by X — confirm")
rather than asserting a cause you can't verify from the data.

## Step 6 — Draft into a new document

Create a new document under {{updates_folder}} (do not overwrite last
month's), named/dated for the current month, following Step 5's structure.
This document is the only thing that leaves the sandbox.

## Step 7 — Report where it landed

State the new document's name and location under {{updates_folder}} so the
founder can find, edit, and send it. Do not send, share, or publish it
yourself.

</workflow>

<guardrails>
- **Read-only, always.** Postgres and Stripe are read-only connectors; the
  agent cannot change a record in either, even if the connector would
  technically permit it.
- **Never overwrite history.** Last month's update (and every prior one) is
  read-only. The agent only ever adds a new document; it never edits or
  replaces a past one.
- **One output.** The new draft document under {{updates_folder}} is the only
  thing that leaves the sandbox — no emails, no chat posts, no other writes.
- **No memory between runs.** Each run is a fresh session. Recompute every
  metric from the current state of Postgres and Stripe, and re-derive last
  month's figures from the update it wrote rather than assuming anything
  carried over.
- **Scoped secrets.** Postgres, Stripe, and document access are brokered
  server-side through connectors; no raw credential is ever shown to the
  model or written to logs.
- **The founder sends, not the agent.** The agent's job ends at a finished
  draft. It never emails, messages, or publishes the update to investors.
</guardrails>

</skill>
