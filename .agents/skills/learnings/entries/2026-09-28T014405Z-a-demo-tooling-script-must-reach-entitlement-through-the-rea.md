---
recorded: 2026-09-28T01:44:05Z
incident_date: 2026-09-28
---
# A demo/tooling script must reach entitlement through the real subscribe route, never a bootstrap-time bypass

**Rule:** A fresh preview account is free tier on purpose
(`accountIsFreeTierForModels`, `apps/api/src/billing/services/tiers.ts` — the
`env === 'dev' || 'preview'` bypass was deliberately removed in 406eb5e9ac
"enforce paid managed model access"). When tooling needs a preview account
entitled to managed models, drive it through the real Stripe test-mode
subscribe route (`POST /v1/billing/create-inline-checkout` +
`confirm-inline-checkout`, the same path `tests/src/fixtures/billing.ts`'s
`subscribe()` and `GW-MANAGED-1` already use). Never add an
environment-gated bypass in account bootstrap, and never write
`entitlement_overrides` / `managed_models_override` from a new code path —
those columns are admin-owned by design
(`apps/api/src/billing/repositories/credit-accounts.ts`'s "there are
deliberately no setters" note) and a second writer is exactly the bypass that
boundary exists to prevent.

**Trigger surface:** Writing or extending demo/QA/CI tooling that needs a
preview or dev account to behave like a paying customer (model access,
credit balance, session limits) — before reaching for an admin override,
a new bootstrap-time flag, or re-adding an environment carve-out to a
tier-gating function.

**Incident:** A factory worker recording a PR demo signed a synthetic
account into a live preview with `preview-sign-in.sh` and could not run a
session: the model picker was empty (`GET .../model-picker` returned
`models: []`, `GET .../billing/account-state` showed `plan.key: "free"`).
Root cause: `accountMayUseManagedModels` → `resolveBillingFromRow` denies
managed models to the `free` plan in every environment, unchanged since
406eb5e9ac. `preview-environments.md` already named the fix ("subscribe with
a Stripe test card") but no tooling did it, so every demo of session
behavior (the core product) was blocked. Fixed by adding
`preview-subscribe.sh` / `preview-subscribe.ts`, which drive the real
subscribe route with the same `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`
test-mode secret already used to test every preview
(`apps/api/.env.staging`, mirroring `KE2E_STRIPE_SECRET_KEY` /
`KE2E_STRIPE_WEBHOOK_SECRET` on the preview runtime allowlist). No billing
code changed; no new secret.

**Enforcement:** none yet: `preview-subscribe.sh` is demo tooling, not
covered by `pnpm test`. `unit-tier-model-entitlement.test.ts` still pins
`accountIsFreeTierForModels`'s environment argument as a no-op, which is the
guard against reintroducing the removed bypass this entry warns against.
