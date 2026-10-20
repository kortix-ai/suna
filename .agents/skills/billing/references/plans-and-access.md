# Plans and access: the spec

Status: implemented on branch `enterprise-layer` (2026-10-15). This file is the
contract the code follows. Change the code and this file together.

## The problem this replaces

Enterprise was modelled as a plan that replaced paying: a contract carried a
credit pool, `tier='enterprise'` removed the account from the self-serve plan,
and operators granted dated trials with warning emails, banners and grace
windows. Customers on a trial could not see how to pay, the trial banner pushed
an "Upgrade" that sales closes, and "Talk to sales" asked a signed-in user for
their name and company again. Two questions were tangled: how much usage an
account buys, and which features it may use.

## Principles

1. **Money and features are separate.** Every account buys usage the same way:
   a billing plan (Free or Credits) plus top-ups. Enterprise never changes that.
2. **Enterprise is a feature entitlement**, nothing else: SSO, SCIM, advanced
   roles, audit export, branding. No credits come with it.
3. **Three Enterprise states, no clocks.** Off, Demo (self-serve) and Licensed
   (a contract). There are no trials.
4. **Exceptions are per-key overrides** in `entitlement_overrides`, each with an
   optional `expires_at`.
5. **The account always sees its state**, and changes go through audited routes.
6. **Never lock people out.** When a license ends, SSO and SCIM stay on for a
   14-day grace.

## Billing plan

| | Free | Credits |
|---|---|---|
| Price | $0 | $50–$50,000 a month (25 ladder tiers; sales above it) |
| Usage | 500 credits a month | Monthly credits, 1-month rollover, top-ups |
| Features | Every self-serve feature except managed models; credit purchases | Same as Free, plus Kortix-managed models |
| Limits | 1 project, free model rate budget | 200 projects, paid model rate budget |

`credit_accounts.tier` is the billing plan: `free` or `credits` (legacy keys
resolve to `credits`). Stripe owns it. `tier='enterprise'` no longer exists.

Compute is billed at Platinum's list rates at 1× on every plan
(`platform/providers/compute-rates.ts`).

## Wallet warning

The sidebar warns while an account can run when its USD wallet falls below
the smaller of $5 and 10% of its positive recurring monthly grant. The
account-state API exposes that grant in USD as `tier.monthly_credits`.
Responses without a positive recurring grant use the existing lifetime-funded
threshold (20% of grants plus purchases, capped at $5); absent funding uses $5. Blocked wallets
continue to use `billing_state`, independently of this soft warning.

## Enterprise

| State | Stored as | How it starts | Features | Limits | BYOK fee |
|---|---|---|---|---|---|
| Off | — | default | plan's | plan's | plan's (on) |
| **Demo** | `credit_accounts.demo_enterprise = true` | an owner or admin turns it on (`PUT /v1/accounts/{id}/iam/enterprise-demo`) | + SSO, SCIM, roles, audit, branding | plan's | plan's (on) |
| **Licensed** | `credit_accounts.enterprise_entitled = true` | an active license contract | + all Enterprise features | Enterprise (uncapped projects/apps) | off |

- Demo has no end date. Turning it on emails Kortix sales
  (`DEMO_LEAD_NOTIFY_EMAIL`), and the account is marked "Demo" wherever
  Enterprise shows. An operator withdraws features from one account with
  per-key overrides.
- `resolve-billing.ts`: `ResolvedBilling.plan` is the billing plan;
  `ResolvedBilling.enterprise` is `'off' | 'demo' | 'licensed'`;
  `ResolvedBilling.features` is the plan whose limits apply (Enterprise only
  when licensed); `entitlements` is the plan's, plus the Enterprise features
  for Demo or Licensed, plus overrides.
- "Talk to sales" inside the app is one click
  (`POST /v1/billing/enterprise/contact`): it emails sales the account, the
  user and the Enterprise state. No form.

## License contracts

A license is a row in `kortix.enterprise_contracts`: `license_usd` per term,
`term_months` (default 12), `collection`, `starts_at`/`ends_at`, status
`offered → active → ended`, or `offered → withdrawn`. `credits_usd` is always
0: a license carries no credits.

Collection:
- `invoice` (the default): a Stripe subscription with `send_invoice`, net 30.
  Active at once; Stripe renews it and each paid invoice moves `ends_at`.
- `checkout`: an offer the billing manager accepts in the app ("Accept and
  pay"), paid by card; active on `checkout.session.completed`.
- `manual`: paid outside Stripe; active at once; ends when `ends_at` passes.

Activation sets `enterprise_entitled = true`. Ending (operator, Stripe
subscription deleted, manual term over) sets it false and writes `sso`/`scim`
overrides expiring 14 days later. Warnings go out 30, 7 and 1 days before a
non-renewing license ends. The billing plan is never touched.

## Bring your own key (BYOK)

A model request on the account's own provider key is billed by the provider
(`apps/api/src/billing/services/byok-fee.ts`):

- The first **$1,000 of list-price BYOK usage per calendar month (UTC)** is
  free. Past it, each request pays **5% of its list price**, from the wallet.
- Never charged: ChatGPT (`openai-codex`) and OpenCode Go (`opencode-go`)
  subscriptions. Billing off (self-host): no fee.
- The fee is the `byokFee` entitlement: on by default, off when Licensed, and
  switchable per account with the `byokFee` override.
- Settled after the request, never at admission: BYOK descriptors stay
  `billingMode: 'none'` (learnings 2026-09-22).

## Overrides

`entitlement_overrides` keys: `managedModels`, `sso`, `scim`, `rbac`,
`auditAccess`, `branding`, `byokFee`. Each `{ value: boolean, expires_at? }`.
Set through `PUT /v1/admin/api/accounts/{id}/overrides`.

## Managed models are sold, never given

Only a paid billing plan or a licensed Enterprise contract carries
`managedModels` (`paysForManagedModels` in `resolve-billing.ts`, applied last).
Free and No Plan never get it: not from the catalog, an override, or the
Enterprise demo. The admin route refuses a `managedModels: true` override on
them with `400`. Two independent gates enforce it at request time:

1. `resolveManagedCandidates` refuses every managed model, the platform
   default and any fallback included, with `plan_upgrade_required`.
2. The billing admission (`assertLlmBillingActive` with `creditsRequest`)
   refuses a Kortix-billed request from such an account.

`unit-managed-models-invariant.test.ts` sweeps every plan key, Enterprise
state and override; `unit-resolve-candidates-free-tier.test.ts` sweeps every
managed id and alias. Learnings 2026-10-19.

## Removed

- Trials: the trial columns are no longer read; `POST`/`DELETE
  /v1/admin/api/accounts/{id}/trial` answer `410 ENDPOINT_RETIRED`; no trial
  banner, sidebar row or warning emails. Active Enterprise trials became Demo.
- `tier='enterprise'`: licensed accounts moved to `credits` (live Stripe
  subscription) or `free`, with `enterprise_entitled = true`. Their expiring
  credits moved to the non-expiring bucket first, so no reset can wipe them.
- Contract credit pools.

## Who may manage billing

`billing.write` (owners and admins): plan checkout and changes, top-ups, auto
top-up, the Stripe portal, accepting a license offer, turning the Enterprise
demo on or off. Members hold `billing.read` and can contact sales. Licenses and
overrides are Kortix-operator actions, each audited.

## Account state (API contract)

`GET /v1/billing/account-state` returns, besides the plan and wallet:

```ts
enterprise: { state: 'off' | 'demo' | 'licensed' };
contract: { status: 'active'; license_usd; term_months; starts_at; ends_at; collection; renews } | null;
enterprise_offer: { id; license_usd; term_months; collection } | null;
grace: { ends_at: string; reason: 'contract_ended' } | null;
trial: null; // deprecated: trials are removed
```

Every timestamp is ISO 8601. `plan` is the billing plan.

## Subscription reconciliation

`POST /v1/billing/sync-subscription` returns 404 when the stored subscription
is absent from the current Stripe account. It leaves the local plan, credits,
and subscription mapping unchanged. A missing remote object does not prove
that the account lost its paid entitlement. Transient Stripe failures propagate.

## Wallet admission and model access

`credits.can_run` and `billing_state` describe wallet admission, not model
readiness. A funded Free account can pay for compute while it uses BYOK.
`model_access.managed` reports resolved managed-model access;
`model_access.requires_provider_key` is true when that access is absent.
The project/principal-scoped `/model-picker` catalog is the source of truth
for executable models. A gateway trigger with no enabled model returns
`402 no_usable_model`; credits alone never unlock managed inference.
