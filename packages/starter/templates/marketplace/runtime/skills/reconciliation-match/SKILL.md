---
name: reconciliation-match
description: >-
  Matching rules, tolerances, and escalation logic for reconciling Stripe
  activity and the bank feed against the invoices tracked in
  {{reconciliation_sheet}}. Load this before comparing a single transaction so
  matches are judged to a consistent standard and only genuine exceptions
  reach a human.
---

<skill name="reconciliation-match">

<overview>
Reconcile `{{reconciliation_sheet}}` once a month without either missing the
near-misses or eating a person's afternoon. A monthly cron fires a fresh
session; the session has no memory of last month, so it reads the sheet's own
history first, then pulls Stripe and the bank feed for the closed period,
matches every line against an invoice, and writes the result back. Clean
matches tie out silently. Anything within tolerance but not exact gets
explained inline. Anything outside tolerance, or with no counterpart at all,
is escalated to a person with both records attached — never force-fit and
never written off.
</overview>

<when-to-load>
- The monthly cron fires the reconciliation run.
- A human asks the agent to reconcile a specific period or re-check a flagged
  mismatch.
</when-to-load>

<workflow>

## Step 0 — Orient from the sheet, not from memory

This is a fresh session — there is no prior turn to resume. The sheet is the
memory.

1. Open `{{reconciliation_sheet}}` and read the last dated reconciliation
   entry to find the period's start (the day after the last close).
2. Read the sheet's "explained mismatches" notes (recurring fees, known
   timing lags, standing exceptions) so this run judges new lines against the
   same standard as past runs, not from scratch.
3. Set the period end to the close date for this run (the day before
   `{{cadence}}` fired, or the explicit period the human gives you).

## Step 1 — Pull Stripe activity for the period

Read (never write) Stripe for the period: charges, payouts, and the fees
withheld on each payout. Capture amount, date, associated invoice/customer
reference, and payout ID for every line — you'll need all four to match.

## Step 2 — Pull the bank feed for the period

Read (never write) the connected bank feed for the same period: deposits and
withdrawals, with amount, date, and any reference/memo the bank provides.

## Step 3 — Match transactions against invoices

For every invoice due or paid in the period, look for:

1. **Exact match** — a Stripe payout and a bank deposit for the same amount
   within 1 business day of each other. Tie out silently.
2. **Tolerance match** — the deposit is short of the invoice/payout amount by
   Stripe's disclosed fee (or by an amount the sheet's notes already explain
   as a recurring fee), or the timing lag is within the sheet's standing
   allowance (default: 3 business days unless the sheet says otherwise).
   Tie out and add a one-line explanation.
3. **Mismatch** — anything else: a payout with no matching deposit, a deposit
   with no matching payout or invoice, a shortfall bigger than the disclosed
   fee, or a lag past the tolerance window.

## Step 4 — Classify every mismatch before escalating

Check each mismatch from Step 3 against the sheet's "explained mismatches"
notes:

- **Recurring, already explained** (e.g., a monthly platform fee the team has
  signed off on before) — tie it out and note which prior explanation it
  matches.
- **New** — this is the one a person needs to see. Do not invent an
  explanation for it.

## Step 5 — Write the summary back to the sheet

Append this run's entry to `{{reconciliation_sheet}}`: the period covered,
counts (clean matches / tolerance matches / escalated), and a row per
escalated mismatch with both records (Stripe reference + bank reference or
"none found") attached so the person reviewing doesn't have to re-pull them.

## Step 6 — Stop — never move money

Your last action is the sheet write. You never issue a refund, initiate a
transfer, or take any action against Stripe or the bank beyond reading. If
something looks like it needs a correction outside the sheet, describe it in
the escalation — don't act on it.

</workflow>

<guardrails>
- **Read-only on Stripe and the bank feed, always.** The only system you
  write to is `{{reconciliation_sheet}}`.
- **No force-fitting.** A mismatch you can't explain within the tolerances
  above is escalated, never rounded off or written off to make the sheet
  balance.
- **No new tolerances invented mid-run.** Tolerances and known recurring
  explanations live in the sheet's notes; if a mismatch doesn't match an
  existing explanation, treat it as new and escalate it.
- **Scoped, brokered credentials.** Stripe, bank feed, and Sheets access are
  injected into the sandbox at runtime and never shown to the model or
  written to logs.
- **One escalation per unresolved line.** Don't batch distinct unmatched
  transactions into a single vague note — a person needs to act on each one.
</guardrails>

</skill>
