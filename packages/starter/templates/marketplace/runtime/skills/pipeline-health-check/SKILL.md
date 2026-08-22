---
name: pipeline-health-check
description: Hourly warehouse health sweep for {{warehouse_schema}}. Checks every monitored table's freshness against its SLA, compares row counts to the table's own trailing baseline, diffs the schema for drift, and checks for failed or stalled loads. Posts anomalies to {{alert_channel}} and drafts a GitHub issue in {{incident_repo}} with the likely cause. Read-only across the warehouse — never modifies data, tables, or pipelines.
---

<skill name="pipeline-health-check">

<overview>
Catch a warehouse problem — a stale table, a row-count anomaly, schema drift, a
failed load — before it surfaces as a wrong number in a downstream dashboard. An
hourly cron spawns a fresh session; this skill turns a scan of
{{warehouse_schema}} into a concrete anomaly (table, evidence, likely cause), an
alert in {{alert_channel}}, and a drafted GitHub issue in {{incident_repo}}.

Proactive and read-only; covers every monitored table in {{warehouse_schema}}
on every sweep. Nothing carries over between sweeps — freshness windows, row
baselines, and schema shapes are all recomputed from the warehouse's own history
each run. Handle each table as an independent unit: a failure or anomaly on one
table never blocks the checks on the others in the same sweep.
</overview>

<when-to-load>
- The hourly pipeline-health sweep fires on its cadence.
- A human asks the agent to check warehouse health or explain a specific
  table's freshness, row count, or schema.
</when-to-load>

<workflow>

## Step 1 — Enumerate the monitored tables (read-only)

Via the Postgres connector, scoped to {{warehouse_schema}}:

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = '{{warehouse_schema}}'
  AND table_type = 'BASE TABLE'
ORDER BY table_name;
```

Skip anything noted as excluded or intentionally low-cadence in skill memory
(e.g. a monthly-refresh reference table). Treat every remaining table as its
own case for the rest of this sweep.

## Step 2 — Check freshness against SLA (read-only)

For each table with a timestamp column (`updated_at`, `loaded_at`,
`created_at`, or whatever the table's load convention is):

```sql
SELECT MAX(<timestamp_column>) AS last_loaded
FROM {{warehouse_schema}}.<table>;
```

Compare `last_loaded` against the table's SLA: a specific one noted in skill
memory if it has one, else the {{freshness_sla_hours}}-hour default. A table
older than its SLA is a **freshness anomaly** — likely cause: the upstream load
job stopped running, is silently erroring, or was disabled.

## Step 3 — Check row count against trailing baseline (read-only)

Compute the baseline from the warehouse's own history rather than any stored
memory — a table with a date/partition column can be trended directly:

```sql
SELECT date_trunc('day', <timestamp_column>) AS day, COUNT(*) AS row_count
FROM {{warehouse_schema}}.<table>
WHERE <timestamp_column> >= now() - interval '14 days'
GROUP BY 1
ORDER BY 1;
```

For a table without a usable date column, compare the current total count to
what it was captured as on the last few sweeps (posted in {{alert_channel}}'s
history) instead. Flag a **row-count anomaly** when today's count is well
outside the trailing trend in either direction:

| Pattern | Likely cause |
|---|---|
| Count far below trend, or zero new rows since last load | Load ran short, silently skipped a batch, or didn't run |
| Count far above trend (e.g. multi-x jump) | Duplicate load, retried job double-inserted, or a batch wasn't deduplicated |
| Count in line with trend | No anomaly |

## Step 4 — Diff the schema for drift (read-only)

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = '{{warehouse_schema}}' AND table_name = '<table>'
ORDER BY ordinal_position;
```

Compare against the shape noted in skill memory or the prior sweep's read (kept
as agent context for this run only, not a durable ledger). A **schema-drift
anomaly** is any added, dropped, renamed, or retyped column since the last
comparison — likely cause: an upstream source schema changed and the load
picked it up (or silently dropped/nulled the new field).

## Step 5 — Check load history for failures (read-only)

If the warehouse has a load/job-run log table (e.g. `etl_runs`,
`load_history`, a dbt `run_results` equivalent):

```sql
SELECT job_name, status, started_at, finished_at, error_message
FROM {{warehouse_schema}}.<load_log_table>
WHERE started_at >= now() - interval '2 hours'
ORDER BY started_at DESC;
```

Any row with a failed/errored status, or a job that started but never
finished within its normal duration, is a **failed-load anomaly** — attach the
`error_message` verbatim as evidence.

## Step 6 — Post the alert and draft the issue

For every anomaly found across Steps 2–5, post one message to
{{alert_channel}}: the table, the anomaly type, the evidence (the timestamp,
the counts, the schema diff, or the error message), and the likely cause from
the tables above. Then draft the incident:

```sh
gh issue create --repo {{incident_repo}} \
  --title "[pipeline-health] <table>: <anomaly type>" \
  --body "Detected by the hourly pipeline-health sweep.

**Table:** {{warehouse_schema}}.<table>
**Anomaly:** <freshness | row-count | schema-drift | failed-load>
**Evidence:** <the timestamp / counts / diff / error message>
**Likely cause:** <cause from Step 2-5>

This is a draft for triage — no data, schema, or pipeline change has been made."
```

A table with no anomaly gets no message and no issue — silence is the
all-clear.

</workflow>

<guardrails>
- **Read-only across the entire warehouse, no exceptions.** No `INSERT`,
  `UPDATE`, `DELETE`, `ALTER`, `DROP`, `TRUNCATE`, or any DDL/DML — every
  connector call in this skill is a `SELECT`.
- **Never touch a pipeline.** No restarting a job, no re-running a load, no
  editing an orchestrator config. Diagnosis only.
- **Draft, not decide.** The GitHub issue is opened as a draft for a human to
  triage; never assign, label as resolved, or close it from this skill.
- **Independent per table.** A failure or anomaly investigating one table
  never stops the checks on the others found in the same sweep.
- **No memory required between sweeps.** Freshness windows, row baselines, and
  schema shapes are recomputed from the warehouse's own history each run — this
  is a fresh session every sweep, not a persistent ledger.
- **Scoped secrets.** The warehouse credential is brokered through the
  connector and the GitHub token is injected at runtime; neither is ever shown
  to the model or written to logs.
- **One alert per anomaly per sweep.** Don't re-alert or re-draft an issue for
  a table already flagged this same sweep.
</guardrails>

</skill>
