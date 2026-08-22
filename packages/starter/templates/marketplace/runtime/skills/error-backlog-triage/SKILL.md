---
name: error-backlog-triage
description: Hourly error-backlog grooming sweep for {{sentry_project}}. Groups new and spiking errors, dedupes against existing GitHub issues in {{triage_repo}} by Sentry issue ID, drafts a GitHub issue with the stack trace and impact for the top {{max_issues_per_run}}, and posts a sweep summary to {{alert_channel}}. Never resolves, ignores, mutes, or assigns an error.
---

<skill name="error-backlog-triage">

<overview>
Groom the Sentry backlog into a short, deduped, ranked list of GitHub issues —
without paging anyone and without deciding anything is fixed. A sweep spawns a
fresh, read-only session; this skill turns the current state of
{{sentry_project}} into grouped errors, a dedupe check against
{{triage_repo}}'s existing issues, drafted issues for the top offenders, and a
Slack summary.

This is backlog grooming, not incident response: it never fires on a single
alert and never pages a human (that's the `oncall-triage` template), and it
never drafts a postmortem after an incident resolves (that's
`incident-postmortem`). It runs on a fixed cadence over the whole backlog and
its only outputs are drafted issues and a summary alert.

Proactive and read-only across Sentry; covers every new-or-spiking error found
in a sweep. Nothing carries over between sweeps — dedupe state comes from
GitHub's own issue list, not an agent-side ledger. Handle each error as an
independent unit: a failure or inconclusive check on one error never blocks
the others found in the same sweep.
</overview>

<when-to-load>
- The hourly error-backlog sweep fires on its cadence.
- A human asks the agent to re-groom the Sentry backlog, or to explain why a
  specific error wasn't drafted as an issue.
</when-to-load>

<workflow>

## Step 1 — Pull the backlog from Sentry (read-only)

Via the Sentry connector, for {{sentry_project}}:

- Issues that are new (first seen since the last hour).
- Issues that are unresolved and whose event frequency over the last hour is
  at least {{spike_multiplier}}x their trailing baseline (e.g. the last 14
  days' hourly average) — a real spike, not steady background noise.

For each one, pull the full stack trace, exception type, first-seen and
last-seen timestamps, total event count, and affected-user count.

## Step 2 — Group and rank

Group the pulled issues by Sentry fingerprint so one root cause is one
candidate, not several. Rank the groups by impact:

```
impact_score = event_count * max(affected_users, 1)
```

Spiking issues rank alongside new ones on the same impact score — a spike in
an old, previously-quiet error can matter as much as a brand-new one.

## Step 3 — Dedupe against GitHub (read-only)

Before drafting anything, check whether each candidate is already tracked:

```sh
gh issue list --repo {{triage_repo}} --state all \
  --search "<sentry-issue-short-id>" \
  --json number,title,url,state
```

Match on the Sentry issue's short ID or permalink (issues drafted by this
skill embed it in the body — see Step 4). If a match exists, mark the
candidate as **already tracked** and skip drafting; note its issue URL for
the Step 5 summary instead.

## Step 4 — Draft the top offenders

For the top {{max_issues_per_run}} candidates that aren't already tracked,
draft one GitHub issue each:

```sh
gh issue create --repo {{triage_repo}} \
  --title "[error-triage] <exception type>: <location>" \
  --label "bug,sentry-triage" \
  --body "Detected by the hourly error-triage sweep.

**Sentry issue:** <permalink> (<short-id>)
**First seen:** <timestamp>
**Impact:** <event_count> events / <affected_users> users
**Trend:** <new | spiking Nx trailing baseline>

**Stack trace:**
\`\`\`
<full trace>
\`\`\`

This is a draft for triage — no error state was changed in Sentry, and no
assignee has been set. A human owns prioritization and ownership from here."
```

Any candidate beyond {{max_issues_per_run}} is left for the next sweep to
re-evaluate against the current backlog — it is not queued or remembered.

## Step 5 — Post the sweep summary

Post one message to {{alert_channel}}: counts of new vs. spiking errors found,
the issues drafted this sweep (title + link), and the candidates skipped
because they're already tracked (with the existing issue's link). A sweep
with nothing new or spiking posts nothing — silence is the all-clear.

</workflow>

<guardrails>
- **Read-only across Sentry, no exceptions.** Never resolve, ignore, mute,
  merge, or delete a Sentry issue from this skill — reporting only.
- **Draft, not decide.** A drafted GitHub issue has no assignee and is never
  labeled or closed as resolved by this skill. A human owns triage from there.
- **Dedupe via GitHub, not a ledger.** Every sweep is a fresh session; the
  "already tracked" check reads GitHub's current issue list each time, never
  an agent-side memory of what was drafted before.
- **Cap per sweep.** Draft at most {{max_issues_per_run}} issues per run, even
  if more candidates qualify — avoid flooding the tracker in one sweep.
- **Independent per error.** A failure or inconclusive check on one error
  never blocks grooming the others found in the same sweep.
- **Scoped secrets.** The Sentry credential is brokered through the connector
  and the GitHub token is injected at runtime for the `gh` CLI; neither is
  ever shown to the model or written to logs.
- **One summary per sweep.** Don't re-post or re-draft for an error already
  handled this same sweep.
</guardrails>

</skill>
