---
name: incident-triage
description: On-call alert triage runbook for {{sentry_project}}. Pulls the Sentry stack trace, correlates Datadog logs around the spike, checks {{target_repo}} for the deploy that shipped just before, classifies severity against known-noisy patterns, posts a first-pass diagnosis to {{incident_channel}}, and pages a human only when severity is at or above {{page_severity_threshold}} or the alert can't be resolved.
---

<skill name="incident-triage">

<overview>
Do the mechanical first minutes of incident response before a human is woken
up. A sweep spawns a fresh, read-only session; this skill turns a raw alert
into a trace, a suspect deploy, a correlated log window, and a severity call —
then decides whether that diagnosis is enough to close the loop or whether it
has to page.

Reactive and read-only; covers every new or still-unresolved alert in
{{sentry_project}}, one case per alert, nothing carried over between sweeps.
</overview>

<when-to-load>
- The alert-triage sweep fires on its cadence.
- A human asks the agent to re-triage a specific alert or explain why one was
  paged (or wasn't).
</when-to-load>

<workflow>

## Step 1 — Pull the alert from Sentry (read-only)

Via the Sentry connector, for every alert in {{sentry_project}} that is new or
still unresolved since the last sweep:

- The full stack trace and exception type.
- Event frequency (spike vs. steady trickle) and the first-seen timestamp.
- Whether Sentry has already grouped it under an existing, previously-seen
  issue fingerprint.

## Step 2 — Correlate the logs (read-only)

Via the Datadog connector, pull the log lines in a window around the
first-seen timestamp (default: 10 minutes before to 5 minutes after), scoped
to the service(s) named in the stack trace. Line the log entries up against
the trace to confirm the failure mode — a matching upstream timeout, a bad
payload, a dependency erroring — rather than trusting the exception message
alone.

## Step 3 — Check recent deploys on GitHub (read-only)

```sh
gh pr list --repo {{target_repo}} --state merged --limit 20 \
  --json number,title,mergedAt,url,author \
  --search "merged:>=<first-seen-minus-2h>"
git log --since="<first-seen-minus-2h>" --until="<first-seen>" --oneline
```

Rank candidate deploys by how closely they precede the first-seen timestamp
and whether the changed files touch the failing service/module. Treat the
closest matching deploy as the suspect, not a certainty — say so in the
diagnosis.

## Step 4 — Classify severity and benign vs. real

| Signal | Classification |
|---|---|
| Matches a known flaky/noisy pattern (repeated transient timeout, third-party rate limit, a fingerprint seen before with no user impact) | Benign — close with reasoning, no page |
| New error type, affects one user or a narrow code path, no matching deploy | Real, low severity — post diagnosis, no page unless it recurs |
| Spike in frequency, matches a recent deploy, or affects a shared/critical path | Real, elevated severity |
| Marked `fatal`/`critical` in Sentry, or severity at or above {{page_severity_threshold}} | Page immediately regardless of diagnosis confidence |
| Trace, logs, or deploy history are inconclusive after Steps 1–3 | Unresolved — page, diagnosis attached as partial context |

## Step 5 — Post the first-pass diagnosis

Post one message per alert to {{incident_channel}}: the error and where it's
from, the first-seen time and frequency, the correlated log lines, the
suspect deploy (PR/commit + author, or "no matching deploy found"), and the
severity classification from Step 4.

## Step 6 — Page or close

- **Page** — at or above {{page_severity_threshold}}, or unresolved per Step
  4: @-mention the on-call rotation in {{incident_channel}} on the same
  message, with the diagnosis attached as context, not a substitute for
  looking at it.
- **Close** — benign or low severity with a confident diagnosis: mark it
  resolved in the post with the reasoning, no page.

Nothing else leaves the sandbox — no ticket creation, no deploy, no rollback,
no config change.

</workflow>

<guardrails>
- **Read-only across every connector.** Sentry, Datadog, and GitHub are
  investigated, never written to — no comments, no resolves-in-Sentry, no
  commits, no deploys, no rollbacks.
- **One diagnosis per alert.** Post exactly one message to {{incident_channel}}
  per alert per sweep; don't re-post an alert already diagnosed this sweep.
- **Page on doubt.** An inconclusive diagnosis pages a human — never guess
  "probably fine" into silence on anything ambiguous.
- **Severity floor is non-negotiable.** Anything at or above
  {{page_severity_threshold}} pages regardless of how confident the diagnosis
  is.
- **Scoped secrets.** Sentry, Datadog, and GitHub credentials are brokered
  server-side through connectors and the GitHub token is injected at runtime;
  never shown to the model or written to logs.
- **No memory required between sweeps.** Each sweep is a fresh session — the
  "new or unresolved since last check" filter comes from Sentry's own issue
  state, not an agent-side ledger.
</guardrails>

</skill>
