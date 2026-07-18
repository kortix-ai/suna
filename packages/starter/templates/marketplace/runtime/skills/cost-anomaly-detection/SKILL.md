---
name: cost-anomaly-detection
description: Daily reusable-session runbook for cloud-spend anomaly detection on AWS. Maintains a per-service/per-account spend baseline from Cost Explorer, flags spend that breaks out of that baseline, attributes the likely driver (a new resource, a traffic surge, a region), and alerts {{alert_channel}} with the delta. Read-only and alert-only — never modifies or deletes a resource or changes a budget.
---

<skill name="cost-anomaly-detection">

<overview>
Catch a cloud cost spike the day it happens, not the day the invoice lands. A
daily cron re-prompts ONE persistent session; this skill turns AWS Cost
Explorer's raw daily spend into a per-service/per-account baseline that
sharpens over time, flags whatever breaks out of it, and attributes a likely
driver so the alert is something a human can act on immediately — not just a
number that moved.

Proactive and schedule-driven; strictly read-only and alert-only.
</overview>

<when-to-load>
- The daily cron fires the cost-anomaly sweep.
- A human asks the agent for current spend anomalies or why a specific service
  or account alerted.
- A human asks the agent to note a known/planned spend pattern so it stops
  being flagged.
</when-to-load>

<workflow>

## Step 0 — Orient and resume

Read the durable ledger first — the current per-service/per-account baseline,
the last date it was updated, prior anomalies and how they resolved, and any
noted seasonal or planned patterns to exclude:

```
.kortix/memory/cloud-cost-baseline.md
```

This is a reuse session re-prompted daily, not a fresh session — the baseline
is cumulative. If the ledger doesn't exist yet, this is the first run: build
the baseline from as much Cost Explorer history as is available (up to 90
days) before flagging anything, and note in the ledger that day one is a
baseline-only run with no alerts.

## Step 1 — Pull the prior day's spend (read-only)

Query AWS Cost Explorer, read-only, for the most recently closed day (Cost
Explorer data typically settles ~24h behind), grouped by:

- **Service** (e.g. EC2, RDS, S3, Lambda, data transfer)
- **Linked account** (for multi-account setups)

Pull both the cost amount and, where available, the usage quantity (so a
price-driven versus usage-driven change can be told apart later).

## Step 2 — Update the baseline

For every service/account pair seen, fold the new data point into its running
baseline (trailing mean and spread over the last ~30 days is a reasonable
default absent a memory override). A pair with no history yet gets one day of
baseline and is not eligible for an anomaly check until it has enough history
to have a meaningful "normal."

## Step 3 — Detect spend that breaks the baseline

Compare each service/account's new data point against its own updated
baseline — never a flat, cross-service dollar threshold. Flag a pair as
anomalous when it clears {{anomaly_threshold_pct}}% above its own baseline
(or a tighter/looser bound noted in the ledger for that specific pair).

| Signal | Read as |
|---|---|
| Spend within {{anomaly_threshold_pct}}% of baseline | Normal — no alert |
| Spend above threshold, one account, one service | Isolated anomaly |
| Spend above threshold, same service across multiple accounts | Possible platform-wide cause (price change, shared config) |
| Spend above threshold, matches a noted seasonal/planned pattern in the ledger | Suppress — do not alert |

## Step 4 — Attribute the likely driver

For each anomaly, look at what changed underneath the number before writing
the alert:

- **New resource** — a resource ID that first appears in the window's
  resource-level detail (new instance, new volume, new function).
- **Traffic surge** — usage quantity (requests, GB transferred, invocations)
  scaled with the cost, on resources that already existed.
- **Region shift** — spend appearing in a region with no or minimal prior
  history for that account.
- **Price/rate change** — cost rose but usage quantity did not, or rose much
  less proportionally.

State the driver as a best guess with the evidence, not a certainty — e.g.
"cost is up 62% vs. baseline; usage (requests) is up 58% over the same window
— looks like a traffic surge, not a new resource."

## Step 5 — Post the alert

Post one Slack message per anomaly to {{alert_channel}} (or one message
covering all of the day's anomalies if there is more than one — never zero
messages folded into a "nothing to report" post; if nothing is anomalous,
post nothing). Each anomaly line carries: the service, the account, the delta
(dollar and percent vs. baseline), and the suspected driver with its
evidence. Never write to AWS — the Slack post is the only output.

## Step 6 — Update the ledger

Update `.kortix/memory/cloud-cost-baseline.md` (see `<ledger-format>`) with
the refreshed baseline, any anomalies alerted today, and any new
seasonal/planned pattern a human has since confirmed. Land a scoped
`memory: cloud-cost-baseline` change request for the ledger update only, after
the Slack alert (or no-alert) has been posted.

</workflow>

<ledger-format>
Lives at `.kortix/memory/cloud-cost-baseline.md`. Keep one section per
service/account pair with: the current baseline (trailing mean + spread, and
the window it's computed over), the last-updated date, and a running note of
whether it's stable or has an active anomaly. Below that, keep a dated
**Anomalies** log (date / service / account / delta / suspected driver /
alerted-to) and a **Known patterns** list (service / account / pattern
description / who confirmed it) for spend spikes to stop flagging. Trim
anomaly log entries older than 90 days.
</ledger-format>

<guardrails>
- **Read-only, always.** The AWS connector is read-only. Never launch,
  modify, or delete a resource, and never change a budget or spending
  control, even if the credential would technically allow it.
- **One alert channel.** {{alert_channel}} is the only output. No emails, no
  tickets, no AWS API writes.
- **Alert only on a real break.** Don't alert on a pair with insufficient
  baseline history, and don't re-alert on a pattern already confirmed and
  noted as known/planned in the ledger.
- **Scoped secrets.** AWS access is brokered server-side through the
  connector; no raw credential is ever shown to the model or written to logs.
- **People decide, not the agent.** The alert states the delta and a
  suspected driver; a human decides whether and how to respond. The agent
  never resizes, stops, or deletes anything to "fix" a spike.
</guardrails>

</skill>
