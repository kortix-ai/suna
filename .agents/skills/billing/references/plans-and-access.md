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

## Billing request budget

After account membership and `billing.write` authorization, interactive billing
operations share a per-account token bucket: five requests per minute per API
process, including portal/setup requests. Plan previews use a separate
per-account bucket with the same limit, so browsing upgrade amounts cannot
consume the confirmation budget. Excess requests
return HTTP 429 with `Retry-After` before calling Stripe. Billing reads and
signed webhooks are not charged to this budget. This bounds runaway callers;
it is not a fleet-wide quota and does not retry failed money operations.

## Billing plan

| | Free | Credits |
|---|---|---|
| Price | $0 | $50–$50,000 a month (25 ladder tiers; sales above it) |
| Usage | 500 credits a month | Monthly credits, 1-month rollover, top-ups |
| Features | Every self-serve feature except managed models; credit purchases | Same as Free, plus Kortix-managed models |
| Limits | free model rate budget | paid model rate budget |

No plan caps workspaces. A workspace holds one project; a person may create
any number of workspaces on Free, and only the first gets the free credits.

`credit_accounts.tier` is the billing plan: `free` or `credits` (legacy keys
resolve to `credits`). Stripe owns it. `tier='enterprise'` no longer exists.

### Free credits: once per person

The Free plan's credits (the signup grant and the monthly rotation) belong to
the first workspace a person creates (Workspaces, 2026-11-05).

- `kortix.free_credit_claims` holds one row per person (`user_id` primary
  key, no foreign key): the account that got the grant. A deleted workspace
  keeps its claim, so a new one never grants twice.
- A person who already owned an account before the rule (their sign-up
  personal account held the grant) writes no claim; their new workspaces get 0.
- A further workspace starts on Free with 0 credits and
  `credit_accounts.free_credits_eligible = false`. The rotation
  (`getFreeAccountsDueForRotation`) and the signup repair
  (`ensureFreeTierAccountReady`) skip it. Its first session gets the usual
  402 `insufficient_credits`, `billing_state: no_subscription`.
- Every row that existed before is `free_credits_eligible = true`: no account
  loses credits. Billing off (self-host) never runs any of this.
- Dormant exception: another account the person owns counts as an earlier
  workspace only when it has a project row or pays (`kortix.account_is_paying`).
  A legacy person whose only account is a dormant sign-up account (no project,
  Free, no purchase) gets the grant on their first created workspace.
- A further workspace has no grant date: `initializeFreeTierAccount({
  freeCredits: false })` writes `next_credit_grant = NULL`.
- The customer sees it: account-state returns `credits.free_grant {eligible,
  claimed_workspace_id}` and, when not eligible, `tier.monthly_credits: 0` and
  `credits.expires_at: null`. `claimed_workspace_id` names the workspace that
  holds the caller's free credits, only on a workspace that is not eligible and
  only when the caller is a member of it. The Plan card, the billing pane and
  the billing modal print the line; the modal opens on the top-up for a Free
  workspace below the run floor (`billingModalNeedsTopUp`).
- Code: `billing/services/free-credit-claims.ts`, called by
  `createOwnedAccount` (`accounts/core/create-account.ts`);
  `billing/services/free-grant.ts` (the claimed workspace).

### Paying (the rule every surface reads)

`kortix.account_is_paying(account_id)`, TS `isPayingAccount`: a paid tier
(`tier NOT IN ('free','none')`), purchased credits
(`lifetime_purchased_precise > 0`), a completed `credit_purchases` row, or an
active Enterprise contract. A `stripe_subscription_id` alone never counts: 149
legacy prod accounts carry a stale one on Free. A split-off comp alone never
counts either: a paid tier with `comp_plan_until` set pays only with a live
Stripe subscription or a RevenueCat subscription the account bought. A
project-less account that
pays is listed as a `setup_required` workspace, so nothing billable is
invisible.

### Split-off billing (Workspaces, design.md §3.2 C6)

The split moves each extra project of a legacy account into its own new
account. The split runner calls `applySplitOffBilling({runId,
sourceAccountId, newAccountId})` after each move
(`billing/services/split-off-billing.ts`):

- Source on Free, or paying only through top-ups or a contract: the
  split-off goes on Free with `free_credits_eligible = true` and gets one Free
  grant (wallet key `split_off_grant:<runId>`). This is the one exception to
  "free credits once per person"; no `free_credit_claims` row is written. A
  source that pays through top-ups or a contract is held until its owner
  confirms the keeper (the split runbook); its purchased credits and contract
  stay with the keeper. A comped split-off is not paying, so a split of it
  is Free too, never a second comp.
- Source on a paid plan: the split-off gets the keeper's plan comped, with no
  Stripe subscription, until min(the keeper's current period end, now + 31 d),
  stored in `credit_accounts.comp_plan_until`. It gets the plan's monthly
  credits pro-rated to that window, expiring at its end (key
  `split_off_comp:<runId>`).
- Comp state: account-state returns `plan_comp {until, source:
  'workspace_split'}` and `credits.expires_at` = `until`; the Plan card reads
  "No charge until <date>, then Free". The comped plan is the paid plan key
  `credits`, so managed models come with it.
- Comp end: the Free rotation tick (`runFreeTierCreditRotation`) first runs
  `expireSplitOffComps`: the account moves to Free with eligibility and a Free
  grant. A split-off that bought its own subscription keeps it; only the
  marker clears.
- `applyStripeSync` never writes a non-paid tier over an active comp, and
  `comp_plan_until` is admin-owned (operator path only).
- Store purchases name the workspace: the mobile app sets the RevenueCat
  subscriber attribute `kortix_workspace_id` before `purchasePackage` and the
  paywall (empty = deleted); `resolveRevenueCatAccountId` credits that
  workspace when the buyer is a member, else the buyer's default account. A
  renewal follows the account that holds the store subscription.
- Cost views across a move: a project-scope read takes a row billed to another
  account only through one of the project's own sessions (marked billed
  elsewhere); account money views stay by `account_id`.
- `previewSplitOffBilling(sourceAccountId)` reports the kind, the comp end and
  the credits for the dry run. `reverseSplitOffBilling({runId, newAccountId})`
  clears the comp and forfeits the split-off credits; it refuses an account
  that took money.
- Every write goes through `applyAdminOverride` and records a
  `billing.split_off.*` audit event. Idempotent per `runId`.

### Billing is per workspace

- Checkout, portal, top-ups and plan changes take the workspace's
  `account_id`.
- Stripe webhooks resolve the account from the customer mapping
  (`billing_customers`) before `metadata.account_id`.
- The legacy Stripe sync never matches customers by email: it adopts only a
  subscription of this account's own customer, or of an unmapped customer
  whose subscription names this account, never one whose `metadata.account_id`
  names another live account, and never one another `credit_accounts` row
  holds (I11). Only `POST /v1/billing/sync-subscription` runs it.
- RevenueCat (`resolveRevenueCatAccountId`): the account that holds the store
  subscription, else the `kortix_workspace_id` subscriber attribute when the
  person is a member of it, else the person's default account.
- Cost views: workspace and session views read `gateway_request_logs` by
  `project_id`, so a moved project keeps its history; rows another account
  paid for carry `billed_elsewhere`. Account money totals stay by
  `account_id`; the payer's per-project rollup labels a moved project
  "Moved to another workspace".

Compute is billed at Platinum's list rates at 1× on every plan
(`platform/providers/compute-rates.ts`).

Residential proxy traffic is metered usage, not a plan feature. Any project
on any plan turns it on per sandbox template (`residential_proxy` in
`kortix.yaml`, or the template form's "Residential IP"). It is served only
where the operator switch `KORTIX_PLATINUM_RESIDENTIAL_PROXY` is on (set it
after that environment's Platinum serves `network.residential_proxy`);
elsewhere such a session does not start. Kortix
debits each charge in Platinum's billing feed at 1×, once per event, from the
account wallet: ledger kind `proxy_debit`, key `platinum-resi:<event id>`
(`billing/services/residential-proxy-charges.ts`, every 5 minutes on the
leader). The usage breakdown counts it under `other`.

Volume storage is metered usage on every plan, like compute. Platinum
meters each volume Kortix creates (a project's Files drive `kd-…`, a
session's /workspace volume `kws-<session_id>`, a box's scratch disk,
Kortix's own Workers' storage) on its stored bytes. Kortix charges what
Platinum metered at `STORAGE_RATES_USD_PER_GIB_HOUR`
(`platform/providers/compute-rates.ts`): Platinum's per-GiB-hour price for
each meter × `PLATINUM_MARKUP`, the same 1× compute uses; the values live in
that file only. There is no included allowance: no other meter has one, and
the Free plan's 500 monthly credits pay for it. Ledger kind `storage_debit`,
key `platinum-storage:<feed>:<kind>:<resource>:<day>:<seq>`, one row per
(control plane, meter, resource, UTC day) in `kortix.storage_charges`
(`billing/services/storage-charges.ts`, hourly on the leader,
`worker/jobs/storage-billing.ts`). Two sources fill a row:

- **Events** (`GET /v1/billing/events?event_type=volume.storage`, Platinum
  #2434): one immutable event per resource per UTC day, split at a resize, a
  price change or a delete, listed ~2 minutes after its span closes. Growth
  Platinum bills back to an ended day arrives as a new event dated that day.
  Each event is applied once (`event_ids` on the row). No volume cap. The
  cursor is `platinum.volume_storage.events.<feed>`.
- **Receipts** (`GET /v1/billing/volume-usage`, at most 1,000 volumes a day):
  the fallback for a Platinum without the events feed, and for the days
  before the feed's first whole day (`fullFrom`). A day stays open for 3
  days after it ends.

A row's metered GiB-hours are the larger of its receipt and the sum of its
events, and each charge is the difference from what was already charged, so
a day read from both sources is charged once. The first tick of a feed
starts both sources at its own day: storage before the feature shipped is
never charged.

The disk of a session or App box that is not running is storage too, metered
exactly as Platinum bills it to Kortix. It is charged only while
`KORTIX_BOX_DISK_CHARGE_ENABLED` is true (default false: every row is recorded
`waived`, nothing is debited, and customer copy says only stored files are
billed). Turning it on charges the days still open, up to 3 days back. The meter is
`billing/services/box-disk-charges.ts`, on the same hourly tick. Platinum bills a box's `disk_gb` while it runs (Kortix
charges that inside compute), while it is stopped (72 µ$/GB-hour, kind
`box_disk`) and while it is archived (36 µ$/GB-hour, `box_disk_archived`);
a box that boots from a root volume bills no disk. Platinum's billing feed no
longer lists box disk, so Kortix meters it from the box list: `stoppedAt`,
`billableSince` (when the box became archived), `diskGb`, `root_disk`. Each
box's time runs from its watermark (`metered_through`) and never starts
before the end of its last Kortix compute window; a box with an open compute
window is skipped. So no hour is billed twice. The archived boxes are listed
every 6 hours and on the first tick of each UTC day. A day is charged once
the box is metered past its end. An archived box that is unarchived or
deleted between two listings is not metered for that part (at most 6 hours,
Kortix's cost).

The `storageBilling` entitlement is on for every plan; the override
`storageBilling: false` waives storage for one account (the row is marked
`waived`), and an account with no credit account is waived (compute's rule).
The usage breakdown counts it under `storage`; the cost explorer shows it per
project (`storage_cost`).

Kortix's own cost is recorded, never charged: a resource no Kortix account
owns is a `storage_charges` row with no account and an `unattributed_reason`
(`not_kortix`, `volume_gone`, `owner_gone`, `unsupported_kind` for legacy
snapshots and Worker storage), and a deleted account or project sets its rows
to unattributed. A stopped or archived box with this deployment's
create-time marker and no session, App or monitor row is a `box_disk` row
with `owner_gone`. Another deployment's boxes in the shared org are left to
that deployment. A running box this deployment created that no Kortix row
owns has its Platinum charge recorded by the orphan reaper before the stop,
in `kortix.provider_orphan_box_costs` (`billing/services/orphan-box-costs.ts`).

Members are unlimited and share the account credit pool. The Plan and account
hub billing panes show the existing account member count alongside an unlimited
allowance; there is no paid-seat denominator.

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
| **Licensed** | `credit_accounts.enterprise_entitled = true` | an active license contract | + all Enterprise features | Enterprise (uncapped Apps) | off |

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
`auditAccess`, `branding`, `byokFee`, `storageBilling`. Each `{ value: boolean, expires_at? }`.
The two Files storage limits take a positive whole number of bytes instead:
`driveProjectBytes`, `driveAccountBytes` (`{ value: number, expires_at? }`).
Set through `PUT /v1/admin/api/accounts/{id}/overrides`.

## Files storage

Every customer's Files live in Kortix's one Platinum org (100 GiB per volume,
one volume per project; 50 TiB stored for the org, `GET /v1/volumes/limits`
2026-11-01). The plan partitions it (`TierConfig.driveStorage` in
`billing/services/tiers.ts`), enforced in `apps/api/src/drives/limits.ts`
before a byte reaches Platinum:

| Plan | One project | All projects of the account |
|---|---|---|
| No Plan, Free | 5 GiB | 5 GiB |
| Credits | 50 GiB | 250 GiB |
| Enterprise (licensed) | 100 GiB | 1 TiB |

The project figure is never above Platinum's volume size. With billing off
(self-hosted) no plan limit applies; Platinum's do. A refused write answers
403 `storage_limit_exceeded` with `limit` (`project_bytes` or
`account_bytes`), `max`, `used` and `requested`. Storage charges are separate
(the billing ledger), not part of these limits.

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

### Credit reset visibility

Account state exposes `credits.expires_at`, the scheduled `next_credit_grant`
reset timestamp, or null for an unknown legacy schedule. Balance cards show
that date beside remaining plan credits. The ledger shows each grant's own
`expires_at` when recorded, never a current account schedule substituted for
a historical grant. New free welcome grants record their scheduled reset date.

## Wallet admission and model access

`credits.can_run` and `billing_state` describe wallet admission, not model
readiness. A funded Free account can pay for compute while it uses BYOK.
`model_access.managed` reports resolved managed-model access;
`model_access.requires_provider_key` is true when that access is absent.
The project/principal-scoped `/model-picker` catalog is the source of truth
for executable models. A gateway trigger with no enabled model returns
`402 no_usable_model`; credits alone never unlock managed inference.
