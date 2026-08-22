---
name: dunning-escalation
description: Per-subscription dunning ladder for recovering failed Stripe payments — smart retry, payment reminder, update-your-card notice, final notice — with minimum wait times between rungs, the ledger format that carries state across hourly runs, and the stop-for-human line at cancellation, credits, and refunds.
---

<skill name="dunning-escalation">

<overview>
Turn a failed Stripe invoice into a worked recovery instead of a silent lapse.
An hourly cron re-prompts one persistent session; this skill defines the fixed
four-rung ladder each failed subscription climbs, how long to wait between
rungs, and what to send at each one. The ledger is what makes this a ladder and
not a loop — without it, every run would just resend rung one forever.
</overview>

<when-to-load>
- The hourly cron fires the payment-recovery sweep.
- A human asks why a specific subscription is or isn't being emailed, or what
  rung it's on.
</when-to-load>

<workflow>

## Step 1 — Resume the ledger

Read `.kortix/memory/payment-recovery-ledger.md`. For every subscription
already tracked, note its current rung, the timestamp of its last action, and
its next-eligible-escalation time. Anything not yet on the ledger is a
candidate for Step 2.

## Step 2 — Pull failed invoices and subscription state from Stripe

Query Stripe for invoices in a failed/past-due state and their parent
subscriptions. For each:

- **New failure** (not on the ledger) → start at rung 1 (smart retry).
- **Already on the ledger** → check whether `now >= next-eligible time`; if
  not, leave it alone this run.
- **No longer failing** (invoice paid, subscription active/current) → go to
  Step 6 (close out), regardless of rung.

## Step 3 — The ladder

| Rung | Name | Action | Minimum wait before this rung |
|---|---|---|---|
| 1 | Smart retry | Retry the failed charge against the existing payment method via Stripe (off-session), no email sent yet | Immediately on first failure |
| 2 | Payment reminder | Friendly email: the charge didn't go through, here's the amount and a pay link | 24h after rung 1 if still failing |
| 3 | Update-your-card notice | Firmer email naming the likely cause (expired/declined card) with a direct link to update the payment method | 48h after rung 2 if still failing |
| 4 | Final notice | Clear, professional email stating this is the last automated reminder before the account needs manual attention | 72h after rung 3 if still failing |

A subscription advances **at most one rung per run**, and only once its
minimum wait has elapsed. Never send two rungs' worth of email in the same
run, and never re-send the same rung.

## Step 4 — Send the rung's email

Send the exact email for the current rung via {{dunning_channel}}, addressed
to the subscription's billing contact. Keep the tone matched to the rung —
rung 2 is a nudge, rung 4 is unambiguous but still professional, never
threatening. Every send is logged to the ledger with the rung and timestamp.

## Step 5 — Rung 4 is the ceiling

Once a subscription has received the final notice and the invoice is still
unpaid, do **not** create a rung 5. Mark it `awaiting-human` on the ledger and
surface it in the Slack summary every run until a person acts or it pays.
Never cancel the subscription, issue a credit, or process a refund — that
decision, and the action, belongs to a human.

## Step 6 — Close out on payment

If a tracked subscription's invoice has been paid (checked fresh from Stripe
every run, not assumed), mark it `recovered` on the ledger with the rung it
was on when it cleared, stop sending it anything, and report it as a recovery
in the summary.

## Step 7 — Post the summary

Post one message per run to {{alert_channel}}: subscriptions that advanced a
rung (with new rung), subscriptions newly at `awaiting-human`, and
subscriptions that recovered since the last run. Omit subscriptions with no
change.

## Step 8 — Update the ledger

Write the full current state back to `.kortix/memory/payment-recovery-ledger.md`
(see `<ledger-format>`) before ending the turn.

</workflow>

<ledger-format>
Lives at `.kortix/memory/payment-recovery-ledger.md`. One row per subscription
currently or recently on the ladder: subscription ID, customer, current rung
(1–4, or `recovered` / `awaiting-human`), last action + timestamp, next-eligible
escalation time, and outcome once resolved (`recovered` with the rung it paid
at, or `awaiting-human` with the date it hit rung 4). Prune a row only after
it's been `recovered` for a full cycle, so a bounce-back failure is still
recognized as a returning case rather than a brand-new one.
</ledger-format>

<guardrails>
- **Smart-retry and dunning only.** The only Stripe write this skill performs
  is retrying an existing failed charge. The only customer-facing action is
  sending one of the four ladder emails. Nothing else is in scope.
- **Never cancel, credit, or refund.** Regardless of how long a subscription
  has been failing, ending it, crediting it, or refunding it requires a human
  and is never done by this skill.
- **One rung per run, minimum wait enforced.** A subscription cannot skip a
  rung or be re-messaged before its wait time elapses, even if a run is
  manually re-triggered.
- **Stops immediately on payment.** A paid invoice ends the ladder for that
  subscription on the very next check — no extra emails, no delay.
- **Scoped secrets.** Stripe access is brokered through the connector; no raw
  key is ever shown to the model or written to logs.
- **Ledger is the source of truth for state.** Between runs, nothing about
  ladder position is inferred or guessed — it comes from the ledger, checked
  against fresh Stripe state.
</guardrails>

</skill>
