---
name: weekly-metrics-report
description: Weekly metrics reporting loop. Queries the metrics tables in Postgres read-only, compares this week against recent weeks, writes plain-language commentary on what moved and why, and posts one report to {{report_channel}}.
---

<skill name="weekly-metrics-report">

<overview>
Build the weekly metrics report without a person spending their Monday on it.
A weekly cron spawns a fresh session with read-only access to the Postgres
database and permission to post to one Slack channel. This skill turns raw
metric rows into a report: the queries to run, the comparison window, what
counts as a notable move, and the layout to post. Every run recomputes from
scratch — there is no report state carried over from the prior week.
</overview>

<when-to-load>
- The weekly cron fires the report run.
- A human asks for the metrics report on demand, or asks why a specific
  number moved.
- The set of tracked metrics or their definitions changes.
</when-to-load>

<workflow>

## Step 1 — Confirm the metric definitions

Metric definitions, the source tables/columns, and what counts as a notable
move live in project memory (`.kortix/memory/weekly-report.md` if present) or
this skill's defaults below. Treat that as the source of truth for exactly
which metrics to report — no more, no less. If a definition is missing or
ambiguous, query the obvious candidate table and note the assumption in the
report rather than guessing silently.

## Step 2 — Query this week's numbers (read-only)

Run each metric's query against the read-only role, scoped to the metrics
tables:

```sql
-- This week's window: Monday 00:00 through now
SELECT metric_name, SUM(value) AS value
FROM metrics
WHERE recorded_at >= date_trunc('week', now())
GROUP BY metric_name;
```

Adapt the table/column names to what the schema actually exposes (e.g.
`events`, `subscriptions`, `invoices`) — the shape above is illustrative, not
literal. The connection is read-only: `SELECT` only, nothing else is
reachable through this role.

## Step 3 — Query the prior weeks for comparison

Pull the same metrics for a trailing window (default: the prior 4 weeks) so a
single-week blip can be told apart from a trend:

```sql
SELECT date_trunc('week', recorded_at) AS week, metric_name, SUM(value) AS value
FROM metrics
WHERE recorded_at >= date_trunc('week', now()) - interval '4 weeks'
  AND recorded_at < date_trunc('week', now())
GROUP BY 1, 2
ORDER BY 1;
```

## Step 4 — Compute the deltas

For each metric, compute week-over-week change and the trend against the
trailing average. Flag as notable:

| Signal | Criteria |
|---|---|
| Notable move | ≥15% change week-over-week, or a break from a 3+ week trend |
| Steady | Within normal week-to-week noise for that metric |
| Missing data | The query returned nothing for the current or a prior week — report the gap, don't fill it with a guess |

## Step 5 — Write the commentary

For every notable move, write one or two plain-language sentences: what
changed, the likely driver if it's inferable from the data (a launch, a
known outage, a seasonal pattern), and whether it's worth the team's
attention. Steady metrics get the number with no commentary — don't manufacture
a narrative for noise.

## Step 6 — Assemble and post the report

One message to {{report_channel}} per run, in this shape:

1. Header — the week's date range.
2. The numbers — every tracked metric with its value and week-over-week
   delta.
3. Commentary — the notable moves, each with its one-line read.
4. A closing note if any metric had missing or suspect data.

Post exactly once. This is a fresh session with nothing to diff against
directly — the deltas come from the Step 3 query, not from any file state —
so there is nothing else to update before finishing.

</workflow>

<guardrails>
- **Read-only, always.** The Postgres role can `SELECT` and nothing else — no
  insert, update, or delete — and it's scoped to the metrics tables. The
  report can never change the data it reports on.
- **One output.** The Slack post to {{report_channel}} is the only thing that
  leaves the sandbox. No writes back to Postgres, no other messages.
- **No memory between runs.** Each run is a fresh session; recompute this
  week's numbers and the trailing comparison from the current database state
  rather than assuming anything from a prior report.
- **Scoped secrets.** Postgres and Slack access are brokered server-side
  through connectors; no raw credential is ever shown to the model or written
  to logs.
- **Report, don't act.** Notable moves get called out with plain-language
  commentary; deciding what to do about them belongs to the team reading the
  report, not the agent.
</guardrails>

</skill>
