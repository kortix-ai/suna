# Free Tier, Pricing, and Onboarding Test Coverage Design

**Status:** proposed test design  
**Source requirement:** `docs/planning/free-tier-pricing-onboarding.md`  
**Coverage strategy:** layered coverage with live E2E as the release proof

## Outcome

The free-tier launch is covered by tests that prove the user-visible flow works end to end and that the money/model-routing invariants hold at the edges. The suite must catch regressions where a new user does not receive a real free wallet, gets routed through the wrong onboarding page, can spend free credits on managed premium LLMs, misses the always-visible upgrade path, or keeps unused free credits across a monthly reset.

## Approach

Use three layers, each aimed at the failure mode it is best at catching:

1. **API unit and route tests** for exact invariants, idempotency, error branches, and time-based monthly reset behavior.
2. **ke2e live API flows** for black-box proof against the running API and real services.
3. **Playwright browser tests** for the public pricing page, direct signup/onboarding, and Upgrade modal visibility.

The live E2E layer is the release proof, but the monthly reset and LLM debit invariants should also have focused lower-level tests so they can cover edge cases without waiting on slow sandboxes or real LLM calls.

## Requirement Coverage

### Free account setup and credits

- Fresh account creation creates or repairs exactly one `credit_accounts` row with `tier='free'`.
- The first free grant is exactly `$5` of expiring wallet balance, displayed as `500 credits`.
- Re-running account bootstrap, account-state, or billing-gate repair does not double-grant.
- Existing paid/per-seat accounts are not downgraded or granted free credits.
- Missing or partially-created billing rows are repaired before the billing gate checks `can_run`.
- A free account with balance at or above the minimum run threshold returns `can_run:true`; below the threshold it fails with a clear insufficient-credit state, not a generic subscription wall.

### Monthly free-credit reset

- At the monthly anchor, unused free credits expire and a fresh `$5` expiring grant is issued.
- If a user signs up today, spends 200 credits, and has `300 credits` remaining at the next monthly reset, the account ends with exactly `500 credits`, not `800 credits`.
- If a user has `20 credits` remaining at reset, those 20 expire and the account ends with exactly `500 credits`.
- If the balance is `0` at reset, the account still receives exactly `500 credits`.
- Running the reset job more than once for the same account and anchor is idempotent and does not duplicate the grant.
- Paid, `none`, deleted, and not-yet-due accounts are skipped.
- A failure for one due free account is recorded without stopping other due accounts from being processed.
- The cron route and in-process worker call the same service path.

### Sandbox-only wallet invariant

- Free Zen/OpenCode model use is allowed and creates no Kortix LLM debit.
- ChatGPT/Codex-subscription model use is allowed and creates no Kortix LLM debit.
- BYOK premium model use is allowed for free accounts with `billingMode:'none'`; the 10% BYOK platform fee is waived.
- BYOK-to-managed fallback is disabled for free accounts.
- Managed premium models on Kortix keys return no candidates or a clear blocked error for free accounts.
- Blocked managed premium attempts leave wallet balance unchanged and create no `llm_debit`.
- Paid/per-seat accounts keep managed premium candidates and normal LLM billing behavior.
- Self-hosted or billing-disabled mode keeps existing managed routing behavior.
- Compute metering remains the only free-wallet debit path and records `compute_debit`.

### Direct onboarding

- A brand-new signup is redirected from the auth callback directly to `/projects/{id}` after the first project is provisioned.
- The user does not see the project selector/dashboard between signup and the first project when provisioning succeeds.
- Replaying the auth callback reuses the existing first project and does not create duplicates.
- If first-project provisioning fails or the free project cap is already consumed, the callback falls back to `/projects` with a retry-safe path.
- The existing `/projects` auto-create fallback still works for accounts that arrive there with zero projects and `can_run:true`.
- Free users can create one project; a second project is blocked before external repo provisioning.

### Pricing and upgrade UI

- `/pricing` shows exactly the intended Free, Team, and Enterprise lineup.
- The Free card states `500 credits / month`, sandbox compute only, monthly expiry, free Zen/OpenCode models, BYOK, and ChatGPT subscription.
- The page does not render the old vague credit examples or long FAQ-heavy copy removed by the requirement.
- The sandbox compute price language is present and approximate.
- A free user sees a persistent Upgrade affordance in app chrome.
- Clicking Upgrade opens the existing global upgrade modal, not a new checkout surface.
- Paid/per-seat users do not see free-only upgrade pressure where the design says it should be free-tier only.

## Test Placement

- Add or extend `apps/api/src/__tests__/billing/*.test.ts` for free account grant, billing gate, account-state credit display, monthly reset, and compute/LLM debit invariants.
- Extend `apps/api/src/__tests__/unit-resolve-candidates-free-tier.test.ts` for BYOK fee waiver, disabled fallback, ChatGPT subscription, billing-disabled behavior, and paid-account contrast.
- Add ke2e flow IDs to `tests/spec/end-to-end.md`, then implement matching flows under `tests/src/flows/billing.flow.ts`, `projects.flow.ts`, and `llm-gateway.flow.ts` as appropriate.
- Add Playwright coverage under `tests/e2e/specs` or the repo's current browser e2e location for pricing, signup redirect, and Upgrade modal behavior.

## Verification Commands

The implementation plan should run the narrowest failing test during each TDD cycle, then finish with:

- `bun test apps/api/src/__tests__/billing/free-tier*.test.ts`
- `bun test apps/api/src/__tests__/unit-resolve-candidates-free-tier.test.ts`
- `cd tests && bun bin/ke2e.ts run --domain billing,projects,llm-gateway`
- `pnpm --filter @kortix/tests test:e2e`
- `npx eslint <touched web test files>`

If live signup or sandbox tests require the local stack, start or reuse `pnpm dev` and verify `http://localhost:8008/v1/health` before running them.

## Non-Goals

- Do not introduce a separate sandbox-credit bucket; tests should enforce the existing unified-wallet invariant.
- Do not require real paid Stripe subscription creation for the free-tier reset tests.
- Do not call real premium LLM providers just to prove routing decisions; candidate resolution and ledger/debit behavior are enough for those edge cases.
