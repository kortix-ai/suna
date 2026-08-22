---
name: nps-theme-analysis
description: Weekly NPS/CSAT theme analysis for {{survey_sheet}}. Reads survey responses from Google Sheets, clusters them into themes with sentiment and detractor drivers, tracks score movement week over week, and posts a summary with representative quotes to {{report_channel}}. Read-only on the sheet and report-only — no writes to any survey system, no respondent contact.
---

<skill name="nps-theme-analysis">

<overview>
Turn a raw NPS/CSAT survey export into a weekly digest a customer-success team
can actually read. A weekly cron spawns a fresh session — there is no memory
between runs, so the Google Sheet the survey tool exports into is the only
source of truth. Each run reads the full response history, clusters the
free-text comments into themes, bands each response by score, isolates the
drivers actually pulling detractors down this week, computes how the score has
moved since the prior period, and posts one summary to Slack.

Read-only and report-only: the agent never edits the sheet and never contacts a
respondent. The output is a Slack message; a human decides what to act on.
</overview>

<when-to-load>
- The weekly cron fires the NPS/CSAT analysis sweep.
- A human asks the agent to analyze survey responses or summarize NPS/CSAT.
</when-to-load>

<workflow>

## Step 1 — Read the survey sheet

Read `{{survey_sheet}}` in full through the `google_sheets` connector,
read-only. Identify the columns: response timestamp, score (0–10 for NPS,
typically 1–5 for CSAT), free-text comment, and any segment/plan column if
present. If column names vary, match by content (a 0–10 numeric column next to
free text is almost always the NPS score).

## Step 2 — Isolate this week's window

Using the timestamp column, split responses into "this week" (since the last
run, one cadence period back) and "prior periods" (everything before). Because
the session is fresh each run, this split is derived entirely from the sheet's
own dates — there is no external ledger to consult.

## Step 3 — Band the scores and tag sentiment

For NPS: promoter (9–10), passive (7–8), detractor (0–6). For CSAT: map the
top band to promoter-equivalent, middle to passive-equivalent, bottom to
detractor-equivalent, using whatever scale the sheet actually uses. For each
response with a comment, tag sentiment (positive / neutral / negative) from the
text itself — a detractor can still leave a neutral comment, and a promoter can
still flag a real complaint.

## Step 4 — Cluster into themes

Group the free-text comments into themes (e.g. pricing, onboarding, support
responsiveness, a missing feature, performance, a specific bug) by what the
respondent means, not the exact wording, using the full response history so a
theme is recognized as recurring even when no two comments phrase it the same
way. For each theme, pick one or two representative quotes and note which score
band they came from.

## Step 5 — Isolate detractor drivers

Filter to this week's detractor responses specifically. Rank the themes that
show up among detractors by frequency, and call out the top few as "detractor
drivers" with a count and a quote each. Compare against prior weeks' detractor
themes: flag any driver that is new this week or has grown in share.

## Step 6 — Compute the score trend

Compute this week's NPS/CSAT score (using the standard formula: %promoters −
%detractors for NPS, or the equivalent top-box rate for CSAT) from the
full history and compare it to the prior period(s) in the same sheet. State
the direction and size of the move, and attribute it: is it more detractors,
fewer promoters, a shift in passives, or some combination.

## Step 7 — Post the weekly summary

Post one message to `{{report_channel}}`:

- This week's score and its move since last period, with the attribution.
- Top themes overall, each with a count and a representative quote.
- Top detractor drivers this week, each with a count, a quote, and whether it's
  new or growing.
- Any notable promoter quotes worth surfacing.

Nothing else is written anywhere. The sheet is never modified, and no
respondent is contacted.

</workflow>

<guardrails>
- **Read-only on the sheet.** The agent never edits a row, adds a column, or
  writes a score back to `{{survey_sheet}}`.
- **Report only, no action.** The agent never emails, messages, or otherwise
  contacts a survey respondent, and never opens a ticket or task on their
  behalf. Deciding what to do about a theme stays with people.
- **Single output.** The only thing that leaves the sandbox is the one weekly
  post to `{{report_channel}}`.
- **Secrets scoped.** The Google Sheets and Slack credentials are injected at
  runtime; never written to disk or logged.
- **Recompute, don't accumulate.** Each run is a fresh session — themes,
  bands, and the trend are always recomputed from the sheet's own history, not
  from a memory file, so there's nothing stale to carry forward or drift from.
</guardrails>

</skill>
