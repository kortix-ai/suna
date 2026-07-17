---
name: ap-invoice-match
description: >-
  Extraction, PO matching, duplicate detection, and overcharge tolerance for
  processing incoming vendor invoices from {{invoice_label}} against the POs
  and ledger in {{ap_ledger}}. Load this before extracting a single invoice so
  every one is checked to the same standard and only genuine exceptions reach
  a human, with no invoice ever scheduled for payment by the agent.
---

<skill name="ap-invoice-match">

<overview>
Process every new vendor invoice landing in `{{invoice_label}}` without missing
a duplicate or an overcharge, and without ever moving toward payment. A cron
fires every `{{cadence}}` against a fresh session; the session has no memory of
the last run, so it reads `{{ap_ledger}}` first, pulls new invoice email,
extracts vendor/amount/line items, matches each against the PO tab and every
prior invoice for that vendor, records the result, and posts the batch to
Slack. Recording and flagging are the agent's job; approving and paying are
not — those stay with a person on every invoice, clean or flagged.
</overview>

<when-to-load>
- The `{{cadence}}` cron fires the invoice-processing run.
- A human asks the agent to re-check a specific invoice or vendor for
  duplicates or overcharges.
- A human asks why an invoice was flagged or missing a PO.
</when-to-load>

<workflow>

## Step 0 — Orient from the ledger, not from memory

This is a fresh session — there is no prior turn to resume. `{{ap_ledger}}` is
the memory.

1. Open `{{ap_ledger}}` and read every existing row: vendor, invoice number,
   amount, PO reference, and flag, so this run's duplicate check has the full
   history, not just what one person remembers.
2. Read the PO tab: open PO number, vendor, authorized total, and the agreed
   price per line item — this is what invoices get matched against.

## Step 1 — Pull new invoice email

Check `{{invoice_label}}` in Gmail for messages not yet reflected in
`{{ap_ledger}}` (match on Gmail message ID or thread ID recorded in the
ledger's last column). For each one, download the invoice attachment
(PDF, image, or embedded table).

## Step 2 — Extract vendor, amount, and line items

From each attachment, extract:

- Vendor name and, if present, vendor ID/tax ID.
- Invoice number and invoice date.
- Total amount due.
- Every line item: description, quantity, unit price, line total.
- The PO number referenced on the invoice, if any.

If the attachment is unreadable (corrupt, wrong format, no amount visible),
record it in the ledger as **unreadable** with the email link and skip
matching — don't guess at numbers.

## Step 3 — Match against the PO

1. If the invoice references a PO number, look it up in the PO tab.
2. **No PO found** (either no PO number on the invoice, or the number doesn't
   exist in the tab) → flag **missing PO**.
3. **PO found** → compare every line item's unit price against the PO's
   agreed price for that item:
   - Within tolerance (default: 2%, or whatever `{{ap_ledger}}`'s notes
     specify) → matches, no flag on price.
   - Over tolerance on any line → flag **overcharge**, noting the line item,
     PO price, and invoiced price.
4. Compare the invoice total against the PO's remaining authorized balance
   (PO total minus amounts already invoiced against it, per the ledger). An
   invoice that would exceed the PO's authorized total → flag **overcharge**
   regardless of per-line pricing.

## Step 4 — Check for duplicates

Compare the new invoice against every existing row in `{{ap_ledger}}` for the
same vendor:

- Same invoice number already recorded → **duplicate**, exact.
- Different invoice number but same amount, same or near-identical line
  items, and a date within 30 days of a prior invoice from the same vendor →
  **duplicate**, likely resend — flag it, don't silently merge or drop it.

## Step 5 — Record every invoice

Append one row per invoice to `{{ap_ledger}}`, flagged or clean: vendor,
invoice number, date, amount, PO reference (or "missing"), line items (or a
link to the attachment), flag (`clean` / `duplicate` / `overcharge` /
`missing-po` / `unreadable`), and the Gmail message ID so this run and future
runs can tell what's already processed.

## Step 6 — Post the batch for approval

Post to `{{approval_channel}}`: every invoice processed this run, grouped
clean vs. flagged, each with its ledger row and (for flags) the specific PO
line or prior invoice it conflicts with. Ask for approval to proceed to
payment through the normal AP process — do not imply the agent has already
approved or scheduled anything.

## Step 7 — Stop — never touch payment

Your last action is the Slack post. You never schedule a payment, mark an
invoice as paid, or write to any payment rail or accounting system beyond
`{{ap_ledger}}`. A clean match is still a person's decision to pay.

</workflow>

<guardrails>
- **No payment action, ever.** The agent has no connector or instruction that
  schedules a payment or marks an invoice as paid — not even for a clean,
  fully matched invoice. That step is always a human's.
- **Record, don't discard.** An unreadable, duplicate, or overcharged invoice
  is still recorded in `{{ap_ledger}}` with its flag — never silently
  dropped.
- **No force-matching.** An invoice with no PO, or a PO match that doesn't
  clear tolerance, is flagged as-is. Don't invent a PO reference or round an
  overcharge down to make it look clean.
- **One flag reason per exception.** State exactly which line, PO, or prior
  invoice triggered a duplicate/overcharge/missing-PO flag so the approver
  doesn't have to re-derive it.
- **Scoped, brokered credentials.** Gmail, Sheets, and Slack access are
  injected into the sandbox at runtime and never shown to the model or
  written to logs.
- **Idempotent per run.** Match new invoices against the ledger's Gmail
  message IDs before processing so the same email is never recorded twice
  across runs.
</guardrails>

</skill>
