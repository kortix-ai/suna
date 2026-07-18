---
name: vendor-doc-intake
description: >-
  Daily vendor-onboarding intake for {{request_label}}. Validates the W-9,
  banking form, and signed contract for every new vendor request against a
  fixed checklist, records every vendor's status in {{vendor_register}},
  drafts a follow-up for anything missing or invalid, and posts the batch to
  {{review_channel}}. Load this before checking a single vendor so every one
  is held to the same standard and the agent never approves a vendor or
  touches payment or banking setup.
---

<skill name="vendor-doc-intake">

<overview>
Process every new vendor request landing in `{{request_label}}` without missing
a missing or invalid document, and without ever moving toward approval or
payment. A cron fires every `{{cadence}}` against a fresh session; the session
has no memory of the last run, so it reads `{{vendor_register}}` first, pulls
new request email, checks the W-9, banking form, and signed contract against a
fixed checklist, records the result, and posts the batch to Slack. Recording
and flagging are the agent's job; approving a vendor and setting up payment or
banking are not — those stay with a person, on every vendor, complete
paperwork or not.
</overview>

<when-to-load>
- The `{{cadence}}` cron fires the intake run.
- A human asks the agent to re-check a specific vendor's document status.
- A human asks why a vendor was flagged or what's still missing.
</when-to-load>

<workflow>

## Step 0 — Orient from the register, not from memory

This is a fresh session — there is no prior turn to resume. `{{vendor_register}}`
is the memory.

Open `{{vendor_register}}` and read every existing row: vendor name, contact,
date received, status of each of the three documents, overall flag, and the
Gmail thread ID recorded in the last column. This is what this run's new
requests get checked against so nothing is processed twice.

## Step 1 — Pull new vendor requests

Check `{{request_label}}` in Gmail for threads not yet reflected in
`{{vendor_register}}` (match on Gmail thread ID). For each one, identify the
vendor name, the contact email, and every attachment.

## Step 2 — Validate against the fixed checklist

Every vendor gets the same three checks, no exceptions:

- **W-9** — a completed IRS Form W-9: legal name, TIN or EIN filled in, and a
  signature with a date. Missing any field, or unsigned → **invalid**.
- **Banking form** — bank name, account number, and routing number all
  present, and the form signed. Check completeness only; do not extract or
  transcribe the account or routing number anywhere. Missing a field or
  unsigned → **invalid**.
- **Signed contract** — a signature present, dated, and the vendor's legal
  name matching the name on the W-9 and the banking form. A name mismatch,
  missing signature, or missing date → **invalid**.

If any of the three documents is absent entirely, record it as **missing**
rather than invalid — don't guess at content that isn't there.

## Step 3 — Cross-check vendor identity

Compare the legal name across all three documents and the contact email's
domain against the vendor name. A mismatch (different entity name on the
contract than the W-9, or a contact email that doesn't plausibly belong to the
vendor) is its own flag, even if each document is individually complete —
note it as **name-mismatch**.

## Step 4 — Record every vendor, flagged or clean

Append or update one row per vendor in `{{vendor_register}}`: vendor name,
contact email, date received, W-9 status, banking form status, contract
status, overall flag (`clean` / `missing` / `invalid` / `name-mismatch`, or a
combination), and the Gmail thread ID. Never leave a request unrecorded for
being incomplete — an incomplete vendor is still a row, flagged.

## Step 5 — Draft a follow-up for anything missing or invalid

For every vendor with any flag, create a Gmail draft addressed to the vendor's
contact naming exactly what's missing or needs correction (e.g. "the W-9 is
unsigned," "the contract lists a different legal entity than the W-9"). Save
it as a draft only — never send it.

## Step 6 — Post the batch for review

Post to `{{review_channel}}`: every vendor processed this run, grouped clean
vs. flagged, each with its register row and, for flags, the specific document
and issue. Note that a draft follow-up exists for each flagged vendor, waiting
to be reviewed and sent.

## Step 7 — Stop — never approve, never touch payment or banking

Your last action is the Slack post. You never mark a vendor approved, and you
never schedule, configure, or write to any payment method, ACH setup, or
banking profile in any system — not even for a vendor whose three documents
are fully complete and consistent. That decision, and the setup that follows
it, is always a person's.

</workflow>

<guardrails>
- **No approval, ever.** The agent has no connector or instruction that marks
  a vendor approved — not even for a fully clean, matched set of documents.
  That step is always a human's.
- **No payment or banking action, ever.** The agent never sets up, schedules,
  or writes to a payment method, ACH enrollment, or banking profile in any
  system, regardless of document completeness.
- **No sensitive data at rest in the register.** Bank account and routing
  numbers are checked for presence and completeness on the source form but
  never transcribed into `{{vendor_register}}` — only a status.
- **Record, don't discard.** A vendor with a missing or invalid document is
  still recorded in `{{vendor_register}}` with its flag — never silently
  dropped or skipped.
- **No force-validating.** Don't infer a signature, a TIN, or a name match
  that isn't actually on the document. Flag it as missing or invalid instead
  of assuming it's fine.
- **Drafts, never sends.** Every outbound email to a vendor is created as a
  Gmail draft. A human reviews and sends it.
- **Scoped, brokered credentials.** Gmail and Google Sheets access are
  injected into the sandbox at runtime and never shown to the model or
  written to logs.
- **Idempotent per run.** Match new requests against `{{vendor_register}}`'s
  Gmail thread IDs before processing so the same request is never recorded
  twice across runs.
</guardrails>

</skill>
