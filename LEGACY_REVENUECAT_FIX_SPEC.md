# Legacy RevenueCat → web claim fix

## Problem

Legacy mobile users can still buy via RevenueCat, but the current web claim flow does not reliably recognize those purchases.

## What I found

1. **RevenueCat webhook logic exists** in `apps/api/src/billing/services/webhooks.ts`, and the route is mounted at `/v1/billing/webhooks/revenuecat`.
2. **The mobile app identifies RevenueCat users with `user.id`, not `accountId`**:
   - `apps/mobile/lib/billing/revenuecat.ts` → `Purchases.configure({ apiKey, appUserID: userId })`
3. **The webhook handler treats `event.app_user_id` as an account id**:
   - `apps/api/src/billing/services/webhooks.ts` → `handleRevenueCatPurchase(appUserId, event)`
   - then writes billing data with `upsertCreditAccount(accountId, ...)`
4. **The machine claim flow uses resolved `accountId`**, not raw `userId`:
   - `apps/api/src/platform/routes/sandbox-cloud.ts` → `const accountId = await resolveAccountId(userId)`
5. **Account-state is inconsistent and currently uses `c.get('userId')` directly instead of resolving account id**:
   - `apps/api/src/billing/routes/account-state.ts`
6. **There is no backend fallback sync endpoint for RevenueCat**, even though the mobile app tries to call one:
   - mobile calls `POST /billing/revenuecat/sync` in `apps/mobile/lib/billing/revenuecat.ts`
   - no such API route exists in `apps/api/src`
7. **There is no current runtime-configured RevenueCat API client path**:
   - `.env.example` and admin settings mention `REVENUECAT_API_KEY`
   - `apps/api/src/config.ts` does not expose `REVENUECAT_API_KEY`
8. **Legacy fallback only reads old `public.credit_accounts`; it never writes to it**:
   - `apps/api/src/billing/repositories/credit-accounts.ts`

## Production verification (Apr 14, 2026)

I verified prod DB and prod API behavior for the two reported users.

### Marcel
- `auth.users.id` = `c98b337d-92e8-48d5-9d94-c743847b45fe`
- `public.credit_accounts` has:
  - `tier = tier_2_20`
  - `provider = revenuecat`
  - `revenuecat_product_id = kortix_plus_monthly`
- `kortix.credit_accounts` has:
  - `tier = tier_2_20`
  - `provider = stripe`
- `kortix.sandboxes` already has an active included machine.
- Prod `GET /v1/billing/account-state/minimal` returns:
  - `tier_key = tier_2_20`
  - `can_claim_computer = false`
  - one active instance

### Nadine
- `auth.users.id` = `334ecb92-4265-40ec-87d4-985ac8f04bac`
- `public.credit_accounts` had:
  - `tier = tier_2_20`
  - `provider = revenuecat`
  - `revenuecat_product_id = kortix_plus_monthly`
- Before claiming, `kortix.credit_accounts` had no row.
- Before claiming, prod `GET /v1/billing/account-state/minimal` returned:
  - `tier_key = none`
  - `can_claim_computer = true`
  - no instances
- I then successfully called prod `POST /v1/platform/sandbox/claim-computer` for Nadine.
- Result:
  - provisioning sandbox created: `31405d95-9b75-461c-bda1-3bd2c5e7f685`
  - `kortix.credit_accounts` row was created with `tier = tier_2_20`
  - prod account-state now returns `tier_key = tier_2_20`, one provisioning instance, and `can_claim_computer = false`

## Updated conclusion from prod

For these two users, the earlier `userId` vs `accountId` mismatch hypothesis is **not the main issue**.

In prod, both users have `accountId = userId`, and the old/public billing row is enough for the current lazy claim flow.

The real prod behavior is:

- old RevenueCat subscribers are represented in `public.credit_accounts`
- the current system can already use that row to allow claim
- claim then lazily creates `kortix.credit_accounts`

So the permanent fix should focus on **legacy public-table reconciliation/backfill**, not resurrecting the old mobile app path.

## Likely failure modes

### A. Webhook missed / failed
If RevenueCat webhook delivery failed, there is no self-healing path. No row gets created in `kortix.credit_accounts`, so the user cannot claim.

### B. Identifier mismatch (`userId` vs `accountId`)
Even if the webhook succeeds, it may write subscription state under `userId`, while claim/provisioning logic reads under resolved `accountId`. That makes the purchase invisible to the claim route.

### C. UI state mismatch
`/billing/account-state` currently uses `userId` directly. This can disagree with the claim route, which resolves `accountId` first.

## Permanent fix

### 1) Normalize RevenueCat processing to account ids
- Resolve `event.app_user_id` to canonical `accountId` before any RevenueCat billing write.
- Store/update all RevenueCat-backed credit account rows under canonical `accountId`.
- Preserve original RevenueCat `app_user_id` separately for debugging/audit if needed.

### 2) Fix account-state route
- Update `apps/api/src/billing/routes/account-state.ts` to resolve `accountId` via `resolveAccountId(c.get('userId'))` before calling `buildAccountState` / `buildMinimalAccountState`.

### 3) Add RevenueCat reconciliation service
- Add backend support for `REVENUECAT_API_KEY` in config.
- Add a small RevenueCat client/service that can:
  - fetch a customer by app user id
  - determine active entitlement/product
  - map product → tier
  - backfill `kortix.credit_accounts`
- Use this in:
  - a new authenticated endpoint (`POST /billing/revenuecat/sync`)
  - an admin/backfill script for existing affected users

### 4) Keep webhook as the primary path, reconciliation as fallback
- Webhook remains source of truth for real-time updates.
- Sync endpoint is only a recovery path for failed/missed webhooks and old users.

### 5) One-time backfill
- Run a script for currently affected users:
  1. resolve `userId` → `accountId`
  2. fetch RevenueCat customer state
  3. upsert correct tier/provider/product under `accountId`
  4. optionally grant missing one-time machine bonus idempotently

## Implementation notes

### Suggested backend changes
- `apps/api/src/billing/routes/account-state.ts`
  - resolve account id before state build
- `apps/api/src/billing/services/webhooks.ts`
  - canonicalize RevenueCat ids before writes
- `apps/api/src/config.ts`
  - add `REVENUECAT_API_KEY`
- `apps/api/src/billing/routes/...`
  - add `POST /billing/revenuecat/sync`
- `apps/api/scripts/...`
  - add one-off backfill script for known affected users and/or all active RevenueCat customers

### Data behavior
- Do **not** create a second parallel source of truth in old public tables.
- Use `kortix.credit_accounts` as canonical state for claim eligibility going forward.
- Keep machine bonus grant idempotent.

## Verification plan

1. Test with a legacy user whose `userId !== accountId`.
2. Simulate RevenueCat `INITIAL_PURCHASE` webhook with `app_user_id=userId`.
3. Confirm billing row is written under resolved `accountId`.
4. Confirm `/v1/billing/account-state` returns `can_claim_computer: true`.
5. Confirm `POST /v1/platform/claim-computer` succeeds.
6. Disable webhook path, run `POST /billing/revenuecat/sync`, and confirm the same end result.
7. Add tests covering:
   - webhook userId→accountId normalization
   - account-state account resolution
   - recovery sync for missed webhook

## Recommended rollout

1. Ship account-state + webhook/account normalization first.
2. Run backfill for known affected users immediately after deploy.
3. Ship sync endpoint and RevenueCat client for future recovery.
4. Add alerting/logging for failed RevenueCat webhook deliveries.

## Immediate unblock for support

For already affected users, continue temporary manual tier activation only until the backfill script is ready. After the permanent fix is deployed, re-run reconciliation for both reported emails and verify they can claim on web.
