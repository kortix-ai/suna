---
recorded: 2026-08-20T14:15:06Z
incident_date: 2026-08-20
commit: 84496e06f5
---
# Entitlement is a property of the subscription, and "has an active subscription" is not "pays us"

**When:** writing any rule that decides what an account may DO — the wallet
floor, a renewal grant, a feature gate. Do not read `credit_accounts.tier` or
`billing_model` as the authority. Both are stale by design: `tier` stays `free`
for paying accounts, `billing_model` stays `per_seat` long after cancellation,
and legacy paid tiers grant no monthly credits at all. Resolve from the
subscription Stripe is collecting on.

The trap on the other side, which is why this is one rule and not two: **the
free tier carries a REAL $0 Stripe subscription whose status is `active`** —
226,931 such rows on prod. So "has a paying subscription" alone is not
"is a paying customer" either. A bypass needs BOTH a collecting subscription
AND a plan that is actually paid for. Widening the paid-plan half from
`per_seat`-only to any paid tier is the fix; dropping it is an uncapped
free-tier hole.

*Incident:* a customer paying $40/mo for "Kortix Computer · Pro" could not run
a single turn. Legacy `pro` grants 0 monthly credits, so the wallet sat at $0
and `checkBillingActive`'s one-cent admission hold 402'd every run; the paid
renewal had granted nothing since April (`getMonthlyCredits('pro') === 0`).
36 accounts in that exact shape on prod, 29 of them at a zero balance.
Fixed in PR #6662.

*Method note — the rule that actually caught the second bug:* the free-tier
hole was not found by 7,538 green API tests, by typecheck, or by driving the
real API with a seeded account. It was found by running one read-only
`GROUP BY tier, billing_model, subscription_status` against **production** to
size the affected population. **Before changing a predicate that gates money or
access, count the rows it will newly admit, per class, on prod.** A local
fixture only proves the class you thought to seed.

*Enforcer:* `billing-state.test.ts` sweeps every Stripe status × plan class,
including a free-tier + `active` $0-subscription case modeled on the real prod
row; `per-seat-pricing.test.ts` pins `resolveRenewalGrant` for per-seat,
configured-grant and paid-by-amount branches.
