# Free Tier, Pricing, and Direct Onboarding — Launch Design

**Status:** approved design  
**Launch deadline:** 25 June 2026 (Marko launch video)

## Outcome

New users can start without a paid subscription. A signup receives a free account with 500 monthly credits for Agent Computer (sandbox) compute, is sent directly into a newly created project, can clearly understand their model options, and can upgrade at any time.

## Scope

Ship one coherent launch flow:

1. New accounts default to the `free` billing tier and receive an idempotent $5 expiring grant, displayed as 500 credits.
2. Free credits pay for sandbox compute only. Free users may use Zen/OpenCode models, their own API key, or a connected ChatGPT/Codex subscription. Managed premium inference is unavailable.
3. The auth callback provisions one initial project and redirects directly to `/projects/{id}`.
4. The public pricing page presents Free, Team ($40/seat/month), and Enterprise with concise model and compute explanations.
5. Every free user sees an Upgrade control in app chrome that opens the existing upgrade modal.

## Architecture

### Billing and model routing

Use the existing unified wallet and meter categories; do not add a second credits column.

- The free tier grants $5 of expiring wallet balance and permits running sandboxes once the existing minimum-run balance check succeeds.
- Free tier has no managed-premium model entitlement. Requests requiring Kortix-managed premium inference are rejected before a debit can occur.
- BYOK runs with `billingMode: 'none'` for free accounts, so the current BYOK fee is not charged. BYOK-to-managed fallback is disabled for those accounts.
- Free Zen/OpenCode and connected ChatGPT/Codex-subscription paths remain non-debit paths to Kortix.
- A free account must therefore only create `compute_debit` entries from its credited wallet. Paid and legacy account behavior remains unchanged.

### Direct onboarding

After authentication, the callback resolves the user’s free account and calls an idempotent initial-project provisioner. It redirects to that project’s canonical route. A repeated auth callback returns the existing onboarding project rather than creating another.

If provisioning cannot complete, redirect to the established `/projects` fallback with a retry-safe onboarding signal. This preserves access and lets the existing first-project flow recover, without an auth loop or a blank page.

### UI

The pricing page is a compact three-plan comparison:

- **Free:** 500 credits/month for sandbox compute; Zen/OpenCode; BYOK or ChatGPT/Codex subscription for premium models; monthly expiry.
- **Team:** $40/seat/month and the existing pooled usage-credit model.
- **Enterprise:** sales contact and existing enterprise capabilities.

It removes nonessential credit examples and long FAQ copy. Compute is described as approximately $0.10/hour, billed by the second and stopped while idle. The page uses existing marketing primitives and Kortix tokens; it introduces no new visual language or decorative animation.

The app shell adds a clearly visible, minimum-40px-target Upgrade control only for free accounts. It reuses the global upgrade-dialog store and modal rather than creating a second checkout path.

## Error handling and safety

- Account setup and initial-project provisioning must be safe to retry.
- Premium-model denial explains the available paths: connect a key or subscription, use a free model, or upgrade. It must not show a generic subscription failure or mutate wallet balance.
- Account-state presents free balance in credits, while paid tiers retain dollar display.
- This launch deliberately does not add the monthly-reset cron, a new schema column, or an exact live sandbox-pricing endpoint. Those are fast-follow work; the first grant uses existing expiry fields.

## Test-first verification

Each behavior begins with a failing test before production code:

1. New-account resolution creates exactly one free credit account and $5 expiring grant.
2. Free routing permits free models/BYOK subscription paths and rejects managed premium without an LLM debit or fallback.
3. Replayed onboarding provisions no duplicate project and redirects to the existing/new project correctly.
4. Account-state shows 500 credits for free accounts.
5. UI tests cover the pricing facts and Upgrade control; live E2E covers signup → direct project → model restrictions → modal.

## Acceptance criteria

- A fresh signup reaches `/projects/{id}` without seeing a project selector.
- Its billing row is `free`, its first grant is $5 expiring balance, and UI shows 500 credits.
- Sandbox use can debit that balance; managed premium LLM requests cannot; free BYOK requests create no Kortix LLM debit.
- `/pricing` accurately shows Free, Team, and Enterprise with the promised concise copy.
- The Upgrade action is visible for a free user and opens the established modal.
