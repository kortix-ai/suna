---
name: invoice-math
description: >-
  Aging buckets, reminder tiers, and dunning cadence for chasing overdue
  invoices. Load this before deciding what reminder an invoice gets so you
  message consistently and don't over-contact a customer.
---

# Invoice math

Rules for turning an invoice's age and balance into the right action.

## Aging buckets

Measure age from the invoice **due date** (not issue date).

| Bucket        | Age (days past due) | Reminder tier   |
| ------------- | ------------------- | --------------- |
| Upcoming      | −7 to 0             | Courtesy notice |
| Just overdue  | 1 to 7              | First reminder  |
| Overdue       | 8 to 30             | Second reminder |
| Seriously late| 31 to 60            | Final notice    |
| Delinquent    | 61+                 | Hold for human  |

## Reminder tiers

- **Courtesy notice** — friendly heads-up that payment is due soon. No pressure.
- **First reminder** — a polite nudge with the amount, due date, and pay link.
- **Second reminder** — firmer; restate the balance and how many days overdue.
- **Final notice** — clear consequence framing; still professional.
- **Hold for human** — do not send. Surface in the summary for a person.

## Dunning cadence

- Send **at most one reminder per invoice per run**, and never two reminders to
  the same invoice within **72 hours** — check the last-sent log first.
- Escalate a tier only when the invoice crosses into the next bucket, not on
  every run.
- Once an invoice is **paid**, stop immediately and note it in the summary.

## Stop-for-human triggers

Regardless of bucket, **do not send** and hand off to a person when the invoice
is:

- over the approval threshold for the account,
- flagged **disputed**, or
- marked for **collections / legal**.
