---
name: billing
description: "Kortix billing: plans (Free, Credits, Enterprise), credits and the wallet, compute and model pricing, trials, enterprise contracts, entitlement overrides and who may manage billing. Load before changing anything under apps/api/src/billing, the admin account billing routes, the web billing/pricing UI, or plan copy."
---

# Billing

The plan model and its lifecycle are specified in
`references/plans-and-access.md`. Read it before you change billing code.
Change the code and the spec together.

## Rules

- **The plan alone decides features.** Never add a flag that turns on part of
  a plan. Time-boxed access is a trial; an exception is an
  `entitlement_overrides` key.
- **One write path.** Plan, trial, contract and override changes go through
  the audited admin routes in `apps/api/src/admin/index.ts`. Never write those
  columns with raw SQL in production.
- **Stripe never overwrites Enterprise.** `applyStripeSync` skips tier writes
  on an Enterprise account; only `activateEnterpriseContract` and the
  contract end set or clear it.
- **Prices live in code once.** Credits: `billing/services/tiers.ts`. Compute:
  `platform/providers/compute-rates.ts`, mirrored by
  `packages/ui/src/internal/billing/compute-pricing.ts`. Model fee:
  `LLM_PLATFORM_FEE_PERCENT`.
- **Customers always see their state.** A new plan state needs an
  account-state field and a visible label.

## Where the code lives

| Concern | Code |
|---|---|
| Plan resolution (plan, trial, overrides, grace) | `apps/api/src/billing/services/resolve-billing.ts` |
| Plans, prices, allowances | `apps/api/src/billing/services/tiers.ts` |
| Enterprise contracts | `apps/api/src/billing/services/enterprise-contracts.ts` |
| Trials | `apps/api/src/billing/services/trial-admin.ts` |
| Warnings and expiry sweeps | `apps/api/src/billing/rotation-schedule.ts`, `workers/billing-rotation-worker.ts` |
| Stripe webhooks | `apps/api/src/billing/services/webhooks.ts`, `stripe-checkout-webhooks.ts` |
| Account state API | `apps/api/src/billing/services/account-state.ts` |
| Admin console | `apps/web/src/app/[locale]/admin/accounts/` |
| Customer UI | `apps/web/src/features/billing/` |
