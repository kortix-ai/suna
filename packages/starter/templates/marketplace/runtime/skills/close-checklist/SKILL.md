---
name: close-checklist
description: >-
  Monthly close runbook: how to walk {{close_sheet}}'s checklist, reconcile
  Stripe revenue against the recorded ledger, judge a missing supporting
  document, and spot an anomaly against prior months. Load this before
  touching a single checklist line so every item is judged to the same
  standard and only genuine open items reach a human.
---

<skill name="close-checklist">

<overview>
Work the month-end close checklist in `{{close_sheet}}` without either
missing a real problem or re-litigating every line by hand. A monthly cron
fires a fresh session with no memory of last month, so it reads the checklist
and ledger tabs' own history first, reconciles Stripe revenue against the
ledger, works the rest of the checklist for missing documentation, flags
anomalies against the trailing months, and posts the open items. Clean lines
tie out silently. Everything else becomes one flagged item for a human.

This skill only assembles and flags. It never writes a journal entry, never
edits a recorded ledger amount, and never marks the checklist or the period
as closed.
</overview>

<when-to-load>
- The monthly cron fires the close run.
- A human asks for close status, or to re-check a specific checklist item or
  flagged line.
</when-to-load>

<workflow>

## Step 0 — Orient from the sheet, not from memory

This is a fresh session — there is no prior turn to resume. `{{close_sheet}}`
is the memory.

1. Open `{{close_sheet}}` and read the checklist tab's current state and the
   prior month's close-status notes (recurring explained swings, standing
   reconciliation tolerances, checklist items with a documented exception).
2. Set the period to the calendar month that just closed (the month before
   `{{cadence}}` fired, unless a human gives an explicit period).

## Step 1 — Pull Stripe revenue for the period

Read (never write) Stripe for the closed period: charges, refunds, and
payouts, with amount, date, and the associated invoice/customer reference for
each. This is the source of truth you reconcile the ledger against.

## Step 2 — Reconcile revenue against the ledger

Read (never write) the ledger tab in `{{close_sheet}}` for the same period.
For every revenue line:

1. **Exact match** — the ledger's recorded amount matches Stripe for the
   period. Tie out silently.
2. **Tolerance match** — the difference is explained by a recurring,
   already-noted pattern in the sheet (a disclosed fee, a standing timing
   lag). Tie out with a one-line reference to the existing note.
3. **Unreconciled** — anything else: a Stripe amount with no matching ledger
   line, a ledger line with no matching Stripe activity, or a difference
   bigger than an existing explanation covers. This is an open item.

## Step 3 — Walk the rest of the checklist

For every remaining checklist item (bank reconciliation attached, AR aging
reviewed, accruals booked, deferred revenue schedule updated, and whatever
else `{{close_sheet}}` lists), check whether the required supporting document
or evidence is present and linked. Anything missing is an open item: name the
checklist row and exactly what's missing.

## Step 4 — Compare against prior months for anomalies

Pull the trailing months of ledger and checklist history from
`{{close_sheet}}`. Flag a figure as an anomaly when:

- It swings more than the sheet's tolerance (default 15% unless the sheet
  states otherwise) against the trailing average, **and**
- The swing has no existing explanation already noted on the sheet.

A swing with a standing explanation (a known seasonal pattern, a one-time
event already logged) ties out silently — don't re-flag it every month.

## Step 5 — Write flags to the checklist, never the ledger

Update only the checklist tab's status and flag columns in `{{close_sheet}}`:
per-item status (clean / needs doc / unreconciled / anomaly) with a short
reason. Never edit a ledger amount, never add a journal line, and never check
off "period closed" or any equivalent completion status — that's a human
action after review.

## Step 6 — Post the close-status summary

Post one summary to `{{close_channel}}`: the period covered, the checklist
completion rate, and every open item grouped by kind (unreconciled revenue,
missing docs, anomalies), each with what a human needs to resolve it. This is
the only channel output for the run.

## Step 7 — Stop — hand off to a human

Your last actions are the checklist flags and the Slack post. You never
write a journal entry, never adjust a ledger amount, and never mark the
checklist or the period as closed. The finance team reviews the open items
and closes the books themselves.

</workflow>

<guardrails>
- **Read-only on Stripe and the ledger, always.** The only thing you write in
  `{{close_sheet}}` is the checklist tab's status and flag columns.
- **No journal entries, ever.** You never create, edit, or suggest a specific
  journal line — that's outside this skill's scope entirely.
- **Never mark the close complete.** No run of this skill checks off "period
  closed" or any equivalent status, regardless of how clean the reconciliation
  came out. That action is a human's alone.
- **No force-fitting.** An unreconciled line or an unexplained swing is
  flagged, never rounded off or explained away without a matching note
  already on the sheet.
- **One flag per open item.** Don't bundle distinct unreconciled lines,
  missing docs, or anomalies into a single vague note — a person needs to act
  on each independently.
- **Scoped, brokered credentials.** Stripe and Sheets access are injected
  into the sandbox at runtime and never shown to the model or written to
  logs.
</guardrails>

</skill>
