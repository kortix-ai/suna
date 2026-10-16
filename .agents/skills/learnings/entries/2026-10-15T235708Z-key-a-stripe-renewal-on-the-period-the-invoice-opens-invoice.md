---
recorded: 2026-10-15T23:57:08Z
incident_date: 2026-10-16
---
# Key a Stripe renewal on the period the invoice opens (invoice.period_end), never invoice.period_start

**Rule:** A `subscription_cycle` invoice is dated by the period that ENDED:
`invoice.period_start` is the start of the period just billed out, and
`invoice.period_end` is the start of the period the renewal opens. Key renewal
idempotency (`last_renewal_period_start`) on `invoice.period_end`, or on the
subscription line's `period.start`. Never compare `invoice.period_start` with a
value that activation recorded from `subscription.current_period_start`: they
are the same instant, and the renewal reads as "already processed".

**Trigger surface:** Handling `invoice.paid` for a renewal, writing
`last_renewal_period_start` at activation, or any "already processed for this
period" check against a Stripe invoice.

**Incident:** 2026-10-16, found while verifying plan changes against Stripe
test mode with a test clock (branch `credits-units`). The first renewal after
a Checkout activation was skipped: the invoice was paid, the log said
`Renewal already processed for period <first period start>`, and the ledger
had no renewal grant, so the account got no monthly credits for its second
month and a scheduled plan cut was not applied. The skip had shipped since
2026-07-01 (`58c7c1fbac`). A read-only aggregate on prod showed accounts whose
first renewal was late or missing; the per-account audit against Stripe
invoices is a follow-up. Fixed by keying on `invoice.period_end`; a redelivered
invoice stays idempotent (same `period_end`, and `wallet.reset` is keyed on the
invoice id).

**Enforcement:** `apps/api/src/billing/services/renewal-rollover.test.ts` —
"the first renewal after activation is granted (Stripe dates a cycle invoice
by the period that ended)" uses Stripe's real date shape (period_start = the
activation period's start) and goes red if the key moves back to
`period_start`.
