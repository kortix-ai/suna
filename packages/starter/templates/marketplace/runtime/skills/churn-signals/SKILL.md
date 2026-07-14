---
name: churn-signals
description: Scoring rules for daily churn-risk detection — usage decline, support friction, billing/payment risk, and renewal proximity — plus how to combine them into a ranked at-risk list with a reason and a suggested next step per account.
---

<skill name="churn-signals">

<overview>
Turn four partial views — product usage, support friction, payment health, and
renewal timing — into one ranked at-risk list. A daily cron spawns a fresh
session with read-only access to Postgres, Plain, and Stripe; this skill turns
those raw signals into a score, a reason, and a next step per account. No
signal is scored in isolation: an account with declining usage but nothing
else is very different from one with declining usage, rising support load,
and a renewal next month.
</overview>

<when-to-load>
- The daily cron fires the churn-risk scan.
- A human asks for the current at-risk list, or why a specific account scored
  the way it did.
</when-to-load>

<workflow>

## Step 1 — Pull usage from Postgres (read-only)

Query per-account activity trend over a rolling window (active seats,
key-feature events, login frequency over the last 30 days vs. the prior 30).
Classify:

| Usage signal | Criteria |
|---|---|
| Stable/growing | Flat or increasing vs. prior window |
| Declining | ≥20% drop in core activity vs. prior window |
| Dormant | Near-zero activity for 14+ days on a previously active account |

## Step 2 — Pull support friction from Plain (read-only)

Pull thread volume and tone per account over the same window.

| Support signal | Criteria |
|---|---|
| Normal | Thread volume in line with the account's history |
| Rising friction | Thread count up materially vs. baseline, or repeated unresolved threads |
| Escalated | An open thread flagged urgent/escalated, or explicit cancellation language |

## Step 3 — Pull billing state from Stripe (read-only)

Pull payment status and renewal date per account.

| Billing signal | Criteria |
|---|---|
| Healthy | Payments current, renewal more than 45 days out |
| At risk | One missed or failed payment in the last billing cycle |
| Renewal-imminent | Renewal within 30 days |

## Step 4 — Combine into one score per account

No single signal alone is high risk. Weigh combinations:

| Combination | Risk |
|---|---|
| Declining/dormant usage alone | Low–medium — watch |
| Declining usage + rising/escalated support | Medium–high |
| Any usage signal + a failed payment | High |
| Declining/dormant usage + renewal-imminent | High |
| Rising/escalated support + renewal-imminent | High |
| Declining usage + rising support + (renewal-imminent or failed payment) | Highest — surface first |
| Stable usage, normal support, healthy billing | Not at risk — omit from the list |

## Step 5 — Write the reason and the next step

For every account that clears the "watch" bar, write:

- **Reason** — the specific signals that fired, e.g. "usage down 34% in 30d,
  2 escalated threads, renewal in 12 days."
- **Next step** — one concrete, human-actionable suggestion tied to the
  dominant signal:
  - Usage decline → a check-in call or re-onboarding nudge.
  - Support friction → proactive outreach from the account's CSM.
  - Payment risk → a billing follow-up (the agent does not send this itself).
  - Renewal-imminent combined with any other signal → prioritize a renewal
    conversation now, not at the renewal date.

## Step 6 — Rank and post

Sort highest risk first. Post one message to {{alert_channel}}: for each
account, its rank, risk level, the reason, and the next step. Post exactly
once per run — this is a fresh session, so there is no prior list to update or
diff against; the whole list is recomputed and reposted every day.

</workflow>

<guardrails>
- **Read-only, always.** Postgres, Plain, and Stripe are read-only connectors.
  Never write to an account, a ticket, or a subscription, even if the
  connector would technically allow it.
- **One output.** The Slack post to {{alert_channel}} is the only thing that
  leaves the sandbox. No emails, no ticket replies, no billing actions.
- **No memory between runs.** Each run is a fresh session; recompute from the
  current state of all three systems rather than assuming anything from the
  prior day's list.
- **Scoped secrets.** Postgres, Plain, and Stripe access is brokered
  server-side through connectors; no raw credential is ever shown to the model
  or written to logs.
- **People decide, not the agent.** The list flags risk and suggests a next
  step; a human on customer success decides whether and how to act.
</guardrails>

</skill>
