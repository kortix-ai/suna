---
name: subscription-audit
description: Weekly SaaS spend audit loop for {{subscription_sheet}}. Pulls recurring card and bank charges from Plaid, reconciles them against the subscription register, flags duplicate/overlapping tools, unused seats, price hikes, upcoming renewals, and shadow IT, and posts a digest to {{alert_channel}} — recommending cancellations and downgrades only, never acting on them.
---

<skill name="subscription-audit">

<overview>
Keep SaaS spend honest without turning into weekly noise. A cron re-prompts a
persistent session that pulls recurring charges from Plaid, reads the
subscription register in {{subscription_sheet}}, and reconciles the two:
duplicate or overlapping tools, seats that look unused, price hikes since the
last check, renewals coming up soon, and shadow IT — recurring charges with no
matching row in the register. Only new or changed findings get reported; an
unresolved item from last week doesn't repeat as if it were new.

Proactive and schedule-driven; read-only against Plaid and the register, with
a single Slack digest as the only output. The agent recommends; it never
cancels, pauses, downgrades, or otherwise modifies a subscription.
</overview>

<when-to-load>
- The weekly cron fires the spend-audit run.
- A human asks for a manual check of SaaS spend or a specific vendor.
- The subscription register is updated and needs a fresh reconciliation pass.
</when-to-load>

<workflow>

## Step 0 — Orient and resume

```sh
cat .kortix/memory/saas-spend-audit-log.md 2>/dev/null || echo "(no ledger yet — first run)"
```

Read the last recorded state for every tracked subscription: its last known
price, when it was last flagged, what was recommended, and whether it's still
open. This run diffs against that history — a subscription flagged last week
with nothing new to say gets skipped, not repeated.

## Step 1 — Pull recurring charges from Plaid

Fetch card and bank transactions for a trailing window (60–90 days) wide
enough to catch both monthly and annual cadences. Group by merchant/payee and
amount to identify which charges are actually recurring — a one-off purchase
is not a subscription.

## Step 2 — Read the subscription register

Read every row in {{subscription_sheet}}: vendor, plan, seat count, price,
renewal date, and owning team, where present. This is the source of truth for
what the business believes it's paying for.

## Step 3 — Reconcile charges against the register

Match each recurring charge to a register row by vendor and amount (allow
small tolerance for currency conversion or a prorated period). A recurring
charge with no matching row, after checking obvious name variants
(`Acme Inc.` vs `Acme, Inc` vs `ACME*SUBSCRIPTION`), is **shadow IT**.

## Step 4 — Detect the five waste signals

| Signal | How to detect |
|---|---|
| **Duplicate / overlapping tools** | Two or more register rows serving the same category (e.g. two project-management tools, two e-signature tools) with active charges on both. |
| **Unused seats** | A register row's seat count against any usage/active-user data available (register notes, admin exports mentioned in the sheet); flag a gap wide enough to matter, not a single idle seat. |
| **Price hikes** | This charge's amount vs. the last price recorded in the ledger or register for that vendor — flag anything above the skill's threshold (default: >5% or any absolute jump worth a person's attention). |
| **Upcoming renewals** | A register renewal date within the next 30 days, especially on an annual plan, so there's time to act before it auto-renews. |
| **Shadow IT** | A recurring charge from Step 3 with no matching register row at all. |

## Step 5 — Filter against the ledger

Drop anything unchanged from a prior week's report. Keep: brand-new findings,
findings where something material changed (price moved again, renewal is now
closer, a previously-unused seat is still unused N weeks later), and anything
a human marked in the ledger as "recheck." Never drop shadow IT until it's
either added to the register or explicitly dismissed by a human.

## Step 6 — Compose and post the digest

One message to {{alert_channel}} per run:

- Group by signal type (duplicates, unused seats, price hikes, renewals,
  shadow IT).
- Each line: the vendor, the evidence (charge amount, register row or its
  absence, the specific numbers involved), and a suggested action — cancel,
  downgrade, consolidate onto one tool, renegotiate before renewal, or
  "add to register and confirm owner" for shadow IT.
- A quiet week (nothing new or changed) gets a single brief line, not a
  re-post of every still-open item in full.

Every recommendation is phrased as a suggestion for a person to execute — the
agent never implies it has taken or will take the action itself.

## Step 7 — Update the ledger

Update `.kortix/memory/saas-spend-audit-log.md` with the current state of
every tracked subscription (see `<ledger-format>`) and a dated log line of what
was reported this week.

</workflow>

<ledger-format>
Lives at `.kortix/memory/saas-spend-audit-log.md`. Maintains, per vendor: the
last known price, the last charge date and amount, the register match status
(matched / shadow IT), the most recent recommendation and its status (open /
dismissed by a human / register updated). Below that, dated **Run log**
entries with what was newly reported, what stayed silent because it was
unchanged, and any reconciliation the agent couldn't resolve (e.g. ambiguous
vendor name match) for a human to confirm next run.
</ledger-format>

<guardrails>
- **Recommend-only.** The agent suggests cancellations, downgrades, and
  consolidations. It never cancels, pauses, downgrades, or otherwise modifies
  a subscription or a payment method — no billing API write access exists.
- **Read-only connectors.** Plaid and the subscription register are read-only.
  The agent never writes a row, a price, or a status into either system.
- **No repeat noise.** The ledger is checked before every post — an unresolved
  finding from a prior week is not re-reported as new.
- **Shadow IT is flagged, not judged.** A charge with no register match is
  reported with its evidence; the agent doesn't assume it's unauthorized or
  recommend blocking the card, only that a human confirm and register it.
- **Secrets scoped.** The Plaid access token and Sheets credentials are
  injected at runtime, never shown to the model or written to logs.
- **Audit rules are code.** Waste thresholds (e.g. the price-hike percentage)
  live in this skill and change through a reviewed change request, not an ad
  hoc instruction mid-run.
</guardrails>

</skill>
