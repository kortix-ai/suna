# Plans and access: the spec

Status: implemented on branch `enterprise-plans` (2026-10-15). This file is the
contract the code follows. Change the code and this file together.

## The problem this replaces

Before this spec, seven mechanisms decided what an account could do: the
stored tier (plus 17 legacy keys), trial columns, trial copies in
`entitlement_overrides`, `enterprise_entitled`, `demo_enterprise`,
`managed_models_override`, and per-key overrides. They disagreed. On
2026-10-14 an enterprise customer's admin-granted trial ended silently: the
account fell to Free (managed models off, no credit purchases) while
`enterprise_entitled` kept SSO on. Nobody was warned. The repair was a raw
production DB write with no audit event.

## Principles

1. **The plan alone decides features.** `free`, `credits` or `enterprise`.
   No flag imitates part of a plan.
2. **Time-boxed access is a dated grant on top of the plan.** A trial names a
   plan, an end date, who granted it and why. When it ends, the account returns
   to the plan it pays for. It never ends silently.
3. **Exceptions are per-key overrides** in `entitlement_overrides`, each with
   an optional `expires_at`. This is the only escape hatch.
4. **The account always sees its state:** plan, why (contract, subscription,
   trial), and until when.
5. **Access changes have one write path**: an audited route. No raw DB writes.
6. **Never lock people out.** When a trial or contract ends, SSO and SCIM stay
   on for a 14-day grace. Everything else follows the base plan at once.

## Plans

| | Free | Credits | Enterprise |
|---|---|---|---|
| Price | $0 | $50–$10,000 a month, self-serve | Custom, annual |
| Usage | 200 credits a month | Monthly credits, 1-month rollover, top-ups | Annual credit pool, top-ups |
| Features | Core | Core + managed models + credit purchases | + SSO, SCIM, advanced RBAC, audit export, branding |
| Bought through | — | Stripe Checkout (`POST /v1/billing/plan`) | Enterprise contract: Stripe Checkout link, Stripe invoice, or recorded manually |

Compute is billed at Platinum's list rates at 1× on every plan
(`platform/providers/compute-rates.ts`). There is no per-account compute rate
multiplier.

## Enterprise contracts

A contract is a row in `kortix.enterprise_contracts`:

| Column | Meaning |
|---|---|
| `id` | uuid |
| `account_id` | the account |
| `status` | `offered` → `active` → `ended`, or `offered` → `withdrawn` |
| `license_usd` | annual platform fee |
| `credits_usd` | annual credit commitment, granted as one pool |
| `term_months` | default 12 |
| `collection` | `checkout` (card, Stripe Checkout), `invoice` (Stripe sends an invoice, net 30), `manual` (paid outside Stripe) |
| `starts_at`, `ends_at` | the active term; `ends_at` null = open-ended (a contract recorded without a term) |
| `stripe_subscription_id`, `stripe_checkout_url` | Stripe links, when collected through Stripe |
| `created_by`, `note`, timestamps | audit |

At most one `active` and one `offered` contract per account.

### Lifecycle

1. **Offer.** A Kortix operator creates the contract in the admin console
   (`POST /v1/admin/api/accounts/{id}/enterprise-contract`).
   - `checkout`: the API creates a Stripe Checkout session (`mode:
     subscription`, yearly `price_data` for the license and the credits on
     product "Kortix Enterprise", metadata `plan_key=enterprise`,
     `contract_id`). The account's billing managers see the offer on the
     billing page with an **Accept and pay** button. The operator can also send
     the link.
   - `invoice`: the API creates the subscription with `collection_method:
     send_invoice`, `days_until_due: 30`. The contract activates at once;
     Stripe emails the invoice.
   - `manual`: the contract activates at once. Payment happens outside Stripe.
2. **Activate.** `activateEnterpriseContract` sets `tier='enterprise'`, ends
   any trial (`converted`), sets `starts_at`/`ends_at`, and records an audit
   event. For `checkout`, the trigger is `checkout.session.completed` with
   `metadata.contract_id`. A credits subscription the account already has is
   cancelled at period end; the Stripe-sync pin keeps `enterprise` from being
   overwritten by that cancellation.
3. **Grant the pool.** The annual credit pool is granted once per term, with
   `expires_at = ends_at`, idempotency key `contract:<id>:<term start>`:
   on `invoice.paid` for Stripe contracts, at activation for `manual`.
4. **Renew.** Stripe renews the yearly subscription. `invoice.paid` for the
   new period grants the next pool and moves `ends_at`. Unused credits of the
   old pool expire with it.
5. **Warn.** 30, 7 and 1 days before `ends_at` (manual contracts and Stripe
   subscriptions set to cancel), billing managers and Kortix ops get an email.
6. **End.** `customer.subscription.deleted`, an operator ending it, or
   `ends_at` passing on a manual contract sets `status='ended'`. The account
   returns to its base plan (`credits` if it has a live credits subscription,
   else `free`), with the 14-day SSO/SCIM grace.

An account on `tier='enterprise'` with no contract row is shown as
"Enterprise" with no end date, and the admin console flags "No contract on
file".

## Trials

A trial is a dated grant of a plan on the trial columns of `credit_accounts`:
`trial_status`, `trial_tier`, `trial_started_at`, `trial_ends_at`,
`trial_note`, `trial_granted_by`.

- Plans: `enterprise` (default 30 days) or `credits` (any amount).
- Credits: one grant at the start, default $500 for an enterprise trial,
  expiring at the trial end. No monthly re-grant and no seats.
- Resolution: while active, the trial plan's entitlements apply
  (`resolve-billing.ts`). Trials no longer write copies into
  `entitlement_overrides`.
- Shown: `GET /v1/billing/account-state` returns `trial: { plan, ends_at,
  days_left }`. The web billing page and account hub show a banner
  "Enterprise trial · N days left" with **Upgrade** (Credits checkout or the
  Enterprise offer) and **Talk to sales**.
- Warned: 7, 3 and 1 days before the end, to billing managers and Kortix ops.
- Ended: the hourly sweep sets `expired` and emails both. SSO/SCIM grace 14
  days.
- Converted: accepting an Enterprise contract converts any trial. Buying a
  Credits plan converts a `credits` trial; an `enterprise` trial keeps running
  until its end, then the account lands on Credits.
- Admin actions: grant (also extends: a re-grant moves the end), revoke,
  convert to a contract offer.

## Overrides

`entitlement_overrides` keys: `managedModels`, `sso`, `scim`, `rbac`,
`auditAccess`, `branding`. Each `{ value: boolean, expires_at? }`. Set through `PUT /v1/admin/api/accounts/{id}/overrides`.
Removed keys: `demoEnterprise`, `enterpriseEntitled`, `managedModelsOverride`,
`computeRateMultiplier`.

## Removed

- `demo_enterprise` (column, JSONB key, IAM and admin routes, the "Turn on the
  preview" card). Accounts with an unexpired demo become 14-day enterprise
  trials with no credit grant.
- `enterprise_entitled` (column, JSONB key, admin route, admin switch). An
  account off the Enterprise plan that had it keeps the five features it
  granted (`sso`, `scim`, `rbac`, `auditAccess`, `branding`) as per-key
  overrides, with the flag's expiry. An Enterprise-plan account gets a
  contract record instead.
- `managed_models_override` column and the `managedModelsOverride` JSONB key.
  The value moves to the `managedModels` key; the JSONB entry wins, as before.
- `computeRateMultiplier` override.
- Trial seats and monthly trial re-grants.

The columns are dropped in a later contract migration, after the API that no
longer reads them is live everywhere.

## Who may manage billing

`billing.write` is held by the `owner` and `admin` account roles. It allows:
plan checkout and changes, top-ups, auto top-up, the Stripe portal, accepting
an Enterprise offer. Members hold `billing.read` and can request credits.
Contracts, trials and overrides are Kortix-operator actions (platform admin),
each audited.

## Account state (API contract)

`GET /v1/billing/account-state` adds:

```ts
trial: { plan: 'credits' | 'enterprise'; ends_at: string; days_left: number } | null;
contract: {
  status: 'active';
  license_usd: number; credits_usd: number;
  starts_at: string | null; ends_at: string | null;
  collection: 'checkout' | 'invoice' | 'manual';
} | null;
enterprise_offer: {
  id: string; license_usd: number; credits_usd: number; term_months: number;
  checkout_url: string | null;
} | null;
grace: { ends_at: string; reason: 'trial_ended' | 'contract_ended' } | null;
```

Every timestamp is ISO 8601. `plan.label` stays the plan name and
`plan.sublabel` stays null: each client builds the localized state line
("Trial · 9 days left", "Annual contract · renews Mar 1, 2027", "SSO until
Nov 3") from `trial`, `contract` and `grace`.
