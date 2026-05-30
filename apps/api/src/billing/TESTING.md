# Billing v2 — Extensive Testing Plan

A complete checklist organized by subsystem. Each test includes setup, action,
and verification SQL. Run in order top-down for a full sweep; cherry-pick by
area for regression testing.

---

## Pre-test setup

Run these once before starting any test pass.

```bash
# 1. DB schema up-to-date
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
  -c "SELECT column_name FROM information_schema.columns WHERE table_schema='kortix' AND table_name='credit_accounts' AND column_name IN ('billing_model','seat_count','auto_topup_customized');"
# Expected: 3 rows

# 2. Stripe webhook listener running
stripe listen --forward-to localhost:8008/v1/billing/webhooks/stripe
# Keep this terminal open during all tests

# 3. API running with the right env
# - NEXT_PUBLIC_ENV_MODE=cloud in apps/web/.env
# - STRIPE_SECRET_KEY=sk_test_* in apps/api/.env
# - STRIPE_WEBHOOK_SECRET matches what `stripe listen` printed

# 4. Test users in Supabase auth
# At minimum: 2 fresh yopmail accounts (owner + invitee)
```

---

## A. Fresh signup + subscription lifecycle

| #   | Scenario                                          | Action                                                   | Expected DB State                                                                                                                                                          | Verify SQL                                                                                                                                                                            |
| --- | ------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Fresh signup lands on per-seat plan               | New user signs up via web UI                             | `credit_accounts` row: `tier='per_seat'`, `billing_model='per_seat'`, `seat_count=1`, `balance=0`, `stripe_subscription_id=NULL`                                            | `SELECT tier, billing_model, balance, stripe_subscription_id FROM kortix.credit_accounts WHERE account_id='<accountId>';`                                                             |
| A2  | Fresh user sees Subscribe CTA, not SeatManagementCard | Open Settings → Billing                              | UI shows "Activate your seat — $20/teammate/month" with Subscribe button                                                                                                   | Visual check                                                                                                                                                                          |
| A3  | First-time subscribe with no card                 | Click Subscribe → land on Stripe Checkout                | Stripe Checkout page appears with $20/month line item                                                                                                                      | Visual check                                                                                                                                                                          |
| A4  | Complete checkout with test card `4242 4242 4242 4242` | Submit checkout form                                | `customer.subscription.created` event in Stripe CLI logs                                                                                                                   | `stripe listen` output                                                                                                                                                                |
| A5  | Webhook lands → $20 grant + seat 1                | (automatic)                                              | `balance=20`, `stripe_subscription_id` set, `seat_subscription_item_id` set, ledger has `seat_grant +$20` (and possibly `tier_grant +$20` from `upsertCreditAccount` path) | `SELECT balance, stripe_subscription_id, seat_subscription_item_id FROM kortix.credit_accounts WHERE account_id='<id>'; SELECT * FROM kortix.credit_ledger WHERE account_id='<id>' ORDER BY created_at DESC LIMIT 5;` |
| A6  | Owner gets YOLO token on subscribe                | (automatic, via `mintYoloTokensForAllMembers`)           | One active row in `yolo_member_tokens` for the owner                                                                                                                       | `SELECT user_id, token_prefix, revoked_at FROM kortix.yolo_member_tokens WHERE account_id='<id>';`                                                                                    |
| A7  | UI switches from CTA to SeatManagementCard        | Refresh Settings → Billing                               | "1 seat · /mo · $20", "Compute $0 / LLM $0" breakdown bars                                                                                                                 | Visual check                                                                                                                                                                          |
| A8  | Subscribe with card already on file (re-purchase after reset) | Click Subscribe after a prior cancellation   | Direct subscription creation (no Checkout redirect), wallet credited immediately                                                                                           | API log: `subscription_created` returned, no `checkout_url`                                                                                                                           |
| A9  | Cancel subscription                                | UI cancel button (or `stripe subscriptions cancel`)     | Stripe sub status → `canceled`, local `tier` reverts to `'free'` (or whatever revertToFree does)                                                                          | `SELECT tier, stripe_subscription_status FROM kortix.credit_accounts WHERE account_id='<id>';`                                                                                       |
| A10 | Idempotent webhook re-delivery                    | `stripe events resend evt_*`                             | No duplicate grants — wallet balance unchanged on resend                                                                                                                   | Compare `balance` before/after; check `credit_ledger.idempotency_key` uniqueness                                                                                                      |

---

## B. Member management (seat lifecycle)

| #   | Scenario                                              | Action                                                            | Expected                                                                                                                                                                        | Verify                                                                                                                                                       |
| --- | ----------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1  | Add new email (not yet a user)                        | Owner invites `random123@yopmail.com` via UI                       | Email sent + `accountInvitations` row created, no `account_members` row yet, no seat sync yet                                                                                   | Check inbox via yopmail.com; `SELECT * FROM kortix.account_invitations WHERE account_id='<id>';`                                                              |
| B2  | Accept invite                                         | Invitee clicks email link → signs up → accepts                    | `account_members` row added, `onMemberAdded` fires, Stripe quantity → 2, webhook lands, `seat_grant +$20`, balance → $40                                                        | `SELECT seat_count, balance FROM kortix.credit_accounts WHERE account_id='<id>'; SELECT * FROM kortix.account_members WHERE account_id='<id>';`              |
| B3  | Add existing auth user directly                       | Owner adds `existing.user@yopmail.com` (already in auth.users)    | Direct add, no email, immediate `onMemberAdded` → seat 2 → +$20 grant                                                                                                           | Same query as B2                                                                                                                                              |
| B4  | Member gets YOLO token on add                         | (automatic)                                                       | Fresh `yolo_member_tokens` row for the new user, `revoked_at=NULL`                                                                                                              | `SELECT user_id, token_prefix FROM kortix.yolo_member_tokens WHERE account_id='<id>' AND revoked_at IS NULL;`                                                 |
| B5  | Auto-topup defaults rescale on add                    | (automatic)                                                       | `auto_topup_threshold` = $5 × seat_count, `auto_topup_amount` = $20 × seat_count                                                                                                | `SELECT auto_topup_threshold, auto_topup_amount FROM kortix.credit_accounts WHERE account_id='<id>';`                                                         |
| B6  | Auto-topup respects user customization                | Owner sets custom values, then adds a member                      | `auto_topup_customized=true` blocks rescale                                                                                                                                     | Set `UPDATE kortix.credit_accounts SET auto_topup_customized=true, auto_topup_amount=100 WHERE account_id='<id>';` then add member → confirm auto_topup_amount stays 100 |
| B7  | Remove member                                         | Owner removes member via UI                                       | `onMemberRemoved` fires, YOLO token revoked (`revoked_at` set), Stripe quantity → N-1, webhook lands, `seat_count -= 1`                                                         | Re-check seat_count + revoked_at                                                                                                                              |
| B8  | Self-leave                                            | Member leaves their own seat                                      | Same as B7, but from member's session                                                                                                                                           | Same                                                                                                                                                          |
| B9  | Cannot leave as last owner                            | Last owner tries to leave                                          | 409 error returned, account_members unchanged                                                                                                                                   | API log shows 409                                                                                                                                             |
| B10 | Re-add removed member                                 | Owner re-adds the removed member                                   | YOLO token row UPSERTed (same `user_id, account_id`, new prefix, `revoked_at=NULL`), `seat_grant +$20` lands                                                                    | YOLO token has fresh `token_prefix`; ledger has another seat_grant                                                                                            |
| B11 | Idempotent invite acceptance                          | User clicks invite link twice                                      | Second accept is a no-op — no double seat sync, no double grant                                                                                                                 | Confirm `seat_count` unchanged on 2nd accept                                                                                                                  |
| B12 | Max seats cap                                         | Add members up to `MAX_SEATS_PER_ACCOUNT = 100`                    | Cap enforced — 101st add fails or Stripe quantity capped at 100                                                                                                                 | Check `seat_count` doesn't exceed 100                                                                                                                         |

---

## C. Compute metering

| #   | Scenario                                | Action                                                                                                          | Expected                                                                                                                       | Verify                                                                                                                                                                                                |
| --- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Start sandbox → metering row opens      | User opens a project session                                                                                    | `sandbox_compute_sessions` row with `state='active'`, captured spec, `started_at=now()`, `cost_usd=0`                          | `SELECT id, state, cpu_cores, memory_gb, started_at, cost_usd FROM kortix.sandbox_compute_sessions WHERE sandbox_id='<sandboxId>';`                                                                   |
| C2  | Spec comes from `kortix.toml [sandbox]` | Set `cpu=4 memory=8 disk=50` in `kortix.toml`, start session                                                    | Row reflects 4/8/50; default 1/2/10 if no toml                                                                                 | Compare cpu_cores/memory_gb/disk_gb                                                                                                                                                                   |
| C3  | Hibernate after idle TTL                | Let session idle for `KORTIX_SANDBOX_IDLE_TTL` (default 1h, can be shortened with env var for testing)          | `pauseComputeSession` fires, row → `state='stopped'`, `ended_at` set, `cost_usd` matches formula, `compute_debit` in ledger    | `SELECT state, ended_at, cost_usd FROM kortix.sandbox_compute_sessions WHERE id='<id>'; SELECT * FROM kortix.credit_ledger WHERE type='compute_debit' AND account_id='<id>' ORDER BY created_at DESC LIMIT 1;` |
| C4  | User-initiated stop                     | Click stop in UI (DELETE session)                                                                               | Same as C3 (`pauseComputeSession` triggers)                                                                                    | Same                                                                                                                                                                                                  |
| C5  | Resume from stopped                     | Click wake / open the session again                                                                              | NEW `sandbox_compute_sessions` row created (the old one stays closed); `state='active'`                                        | Should see 2 rows for the same sandbox_id, one finalized, one active                                                                                                                                  |
| C6  | Restart sandbox                         | UI restart action                                                                                                | Old row → `state='finalized'`, then new row opens                                                                              | Same pattern as C5                                                                                                                                                                                    |
| C7  | Cron tick partial-bills long-running    | Wait for `runProjectMaintenance` (every 5 min) with a session running ≥ 1h                                       | `tickRunningComputeCharges` settles a partial window — `cost_usd` increases, `last_billed_at` advances, row stays open         | `SELECT cost_usd, last_billed_at FROM kortix.sandbox_compute_sessions WHERE id='<id>';` before/after the tick                                                                                         |
| C8  | Insufficient balance during compute     | Drain wallet to $0 with sandbox running                                                                          | `deductCredits` throws, settle catches it, row stays open with accrued cost, no debit lands but cost field grows               | Check logs for `[compute-metering] failed to debit ... InsufficientCreditsError`; balance stays at 0                                                                                                  |
| C9  | Multiple concurrent sandboxes           | Spin up 3 sandboxes in different projects under same account                                                     | All 3 have separate `sandbox_compute_sessions` rows; each debits independently on stop                                         | `SELECT sandbox_id, account_id, state FROM kortix.sandbox_compute_sessions WHERE account_id='<id>' AND ended_at IS NULL;`                                                                             |
| C10 | Legacy account doesn't meter            | Flip an account to `billing_model='legacy'`, start a sandbox                                                     | NO `sandbox_compute_sessions` row created (gated by `isPerSeatAccount` check in `startComputeSession`)                          | `SELECT COUNT(*) FROM kortix.sandbox_compute_sessions WHERE account_id='<legacyId>';` should stay 0                                                                                                   |
| C11 | Per-member attribution                  | Member B starts a sandbox in account A's project                                                                 | Row's `actor_user_id` = member B's user_id, `account_id` = A's account_id                                                      | `SELECT actor_user_id FROM kortix.sandbox_compute_sessions WHERE sandbox_id='<id>';`                                                                                                                  |
| C12 | Cost formula sanity                     | Run a 2vCPU/4GB/20GB sandbox for exactly 60 seconds                                                              | `cost_usd ≈ $0.001020` (within float tolerance)                                                                                | Math: `(2×0.0000111 + 4×0.00000139 + 20×0.0000000278) × 60 × 1.2`                                                                                                                                     |

---

## D. YOLO token lifecycle

| #   | Scenario                                   | Action                                                                  | Expected                                                                                                                            | Verify                                                                                                                  |
| --- | ------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| D1  | Token minted at subscribe (owner)          | Owner subscribes                                                         | One `yolo_member_tokens` row, `revoked_at=NULL`                                                                                     | `SELECT * FROM kortix.yolo_member_tokens WHERE account_id='<id>';`                                                       |
| D2  | Token minted on member add                 | Add a member to a per-seat account                                       | New row for that member                                                                                                             | Same                                                                                                                    |
| D3  | Token NOT minted for legacy account        | Add a member to a legacy account                                         | No new YOLO row                                                                                                                     | Count stays 0                                                                                                            |
| D4  | Token revoked on member remove             | Remove a member                                                          | `revoked_at` set on their row                                                                                                       | `SELECT revoked_at FROM kortix.yolo_member_tokens WHERE user_id='<userId>';`                                             |
| D5  | Token UPSERTed on re-add                   | Remove then re-add the same member                                       | Same `(user_id, account_id)` row, `revoked_at=NULL`, fresh `token_prefix` and `token_hash`, fresh `created_at`                       | Check the prefix changed but PK matches                                                                                  |
| D6  | Token injected into sandbox env            | Start a sandbox as a per-seat member                                     | Sandbox env has `KORTIX_YOLO_API_KEY=kyolo_*` matching the member's plaintext                                                       | Inspect sandbox env (e.g., `docker exec` or `daytona ssh` and `cat /run/s6/container_environment/KORTIX_YOLO_API_KEY`)  |
| D7  | Different members get different tokens     | Member A starts sandbox X, member B starts sandbox Y                     | X has A's token, Y has B's token                                                                                                    | Inspect both sandboxes                                                                                                   |
| D8  | Self-healing on cache miss                 | Restart API, then start a sandbox as a per-seat member                   | `resolveYoloTokenForMember` auto-mints when cache is empty (rotates)                                                                | Old plaintext in old sandbox stops working; new sandbox has fresh prefix                                                 |
| D9  | Legacy account → no token injection        | Per-seat member opens sandbox in account that's still legacy             | No `KORTIX_YOLO_API_KEY` set by per-member path; falls back to account-wide injection (legacy behaviour)                            | sandbox-auth.ts fallback path                                                                                            |
| D10 | Attribution lookup                          | API receives YOLO API call with `Bearer kyolo_*`                         | `attributeYoloToken(plaintext)` returns the correct `(userId, accountId)`                                                           | Unit test via direct call                                                                                                |

---

## E. Auto-topup

| #  | Scenario                                  | Action                                                                                            | Expected                                                                                              | Verify                                                                                                                |
| -- | ----------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| E1 | Topup triggers below threshold            | Set `auto_topup_enabled=true`, drain wallet to $4 (threshold = $5 for 1 seat)                     | Stripe charge for $20, balance back to ~$24                                                           | `SELECT balance, auto_topup_last_charged FROM kortix.credit_accounts; stripe events list --limit 1`                   |
| E2 | Topup respects rate limit                 | Force multiple debits in quick succession at threshold                                            | Only ONE topup fires (dedup via `auto_topup_last_charged`)                                            | Check ledger has single topup entry per cooldown window                                                                |
| E3 | No card on file                            | Disable saved payment method, drain wallet                                                        | Topup attempt fails gracefully, `payment_status='failed'` set, logged warning                          | `SELECT payment_status, last_payment_failure FROM kortix.credit_accounts;`                                            |
| E4 | Disabled topup → wallet hits $0           | `auto_topup_enabled=false`, drain wallet                                                          | Balance stays at $0, no Stripe charges, compute debits start failing                                  | Wallet stuck at $0; logs show insufficient credit                                                                       |
| E5 | Defaults rescale with seats               | Add a 5th member → topup defaults should become $25 threshold / $100 amount                       | Auto-applied unless `auto_topup_customized=true`                                                       | `SELECT auto_topup_threshold, auto_topup_amount FROM kortix.credit_accounts;`                                          |
| E6 | User-customized values preserved           | Set custom, then add a member                                                                     | Custom values not overwritten                                                                          | E6                                                                                                                     |

---

## F. Webhook reconciliation

| #  | Scenario                                          | Action                                                                                | Expected                                                                                                | Verify                                                                                |
| -- | ------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| F1 | `customer.subscription.updated` quantity change   | `syncSeatQuantity` calls Stripe → webhook fires                                       | `seat_count` updated in DB, `seat_grant` for delta lands                                                | F2 below                                                                              |
| F2 | Idempotent event re-delivery                       | `stripe events resend evt_*`                                                          | Second delivery is no-op (idempotency key collision on `credit_ledger`)                                 | Ledger entry count unchanged                                                          |
| F3 | Stale subscription rejected                        | Send `subscription.updated` for an old sub_id that's not on the account               | Webhook logs `skipping stale subscription`                                                              | API log check                                                                         |
| F4 | Webhook arrives before local DB write completes    | Race test: send Stripe API call + webhook in quick succession                         | Final state is consistent (last writer wins, idempotency holds)                                         | DB matches expected steady state                                                      |
| F5 | `subscription.deleted`                             | Cancel sub                                                                            | Account reverts to `tier='free'`, balance retained                                                      | `SELECT tier, stripe_subscription_status, balance FROM kortix.credit_accounts;`        |
| F6 | `invoice.paid` (renewal)                           | Wait for monthly renewal OR `stripe trigger invoice.paid`                             | Expiring credits reset for yearly plans (if applicable); per-seat: no-op (grants are quantity-driven) | F7                                                                                    |
| F7 | `invoice.payment_failed`                           | Force a card-decline test event                                                       | `payment_status='failed'`, `last_payment_failure` timestamp set                                         | DB check                                                                              |
| F8 | Signature verification                             | Send a forged event with wrong signature                                              | Webhook rejects with 400                                                                                | `curl -X POST .../webhooks/stripe -d '{...}' -H 'Stripe-Signature: bad'`              |
| F9 | Replay attack                                      | Re-send the same `evt_*` after 10 minutes                                             | Dedup map in webhook service blocks (in-memory; bounded at 500 events)                                  | Confirm 2nd processing logged as skipped                                              |

---

## G. Legacy customer protection

| #  | Scenario                              | Action                                                              | Expected                                                                                                                          | Verify                                                                              |
| -- | ------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| G1 | Existing legacy account unchanged      | Pick a `tier_2_20` account; observe state before/after deploy       | All fields untouched: tier, balance, sub_id unchanged                                                                             | Snapshot before, compare after                                                       |
| G2 | Add member to legacy account           | Owner of legacy tier adds a member                                   | `account_members` row created, but NO seat sync to Stripe, NO YOLO token, NO grant                                                | `SELECT * FROM kortix.yolo_member_tokens WHERE account_id='<legacyId>';` → 0 rows   |
| G3 | Run sandbox on legacy account          | Start a sandbox                                                      | No `sandbox_compute_sessions` row; legacy compute model (flat machine tier) applies                                                | F1 query → 0 rows                                                                    |
| G4 | Webhook for legacy sub                 | `subscription.updated` for legacy tier price                         | NO seat fields set, NO seat_grant, just regular tier sync                                                                          | Check `seat_count`, `billing_model` stay at default                                  |
| G5 | Legacy account voluntary migrate       | (Future feature, placeholder admin endpoint)                         | Explicit `POST /admin/billing/migrate-to-per-seat` flips billing_model, doesn't touch existing balance                              | TBD when migration endpoint exists                                                   |

---

## H. Multi-tenant / access control

| #  | Scenario                                                              | Action                                            | Expected                                                                                | Verify     |
| -- | --------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------- |
| H1 | Member in workspace A doesn't see workspace B                          | Member of A signs in                              | Only A appears in account switcher                                                      | UI check   |
| H2 | Member acts in A — bills A, not their personal                         | Member starts a sandbox in A                      | `sandbox_compute_sessions.account_id = A`, NOT their personal account                   | DB check   |
| H3 | Member of multiple paid workspaces                                     | User is in workspace A AND workspace B (both per_seat) | Each pays $20/seat for them independently                                          | A and B each show seat_count including this user |
| H4 | Member cannot view Billing tab in workspace they're not owner of       | Member opens AccountSettings                      | Billing tab shows but Subscribe button disabled / sub data read-only                    | UI check (or 403 if you've gated by role) |
| H5 | Member cannot remove other members                                     | Try DELETE /accounts/:id/members/:userId as a non-admin | 403 returned                                                                       | API log    |
| H6 | Member cannot cancel sub                                               | Try POST /billing/cancel-subscription as non-admin | 403 returned                                                                            | Same       |
| H7 | Project ACL respected                                                  | Member without `project_members` row can't see owner's projects | Owner's projects hidden from member's UI                                       | UI check   |

---

## I. UI/UX surface

| #  | Scenario                                                                | Expected                                                | Verify              |
| -- | ----------------------------------------------------------------------- | ------------------------------------------------------- | ------------------- |
| I1 | Fresh signup → Billing tab → "Activate your seat — $20/teammate" CTA    | Visual                                                  | Screenshot          |
| I2 | Subscribed user → Billing tab → SeatManagementCard with breakdown       | Visual                                                  | Screenshot          |
| I3 | Balance display matches DB                                              | Display "$X.XX" matches `credit_accounts.balance`       | UI vs SQL           |
| I4 | Compute usage bar updates after sandbox stops                           | Spin sandbox, stop it, refresh Billing tab              | Bar shows non-zero $$ | UI               |
| I5 | LLM usage bar updates after a chat                                      | (Once router wires `deductForLlmUsage`)                 | Bar reflects token spend | Not yet wired — known gap |
| I6 | Settings → User menu → Billing item visible only in cloud mode          | Set `NEXT_PUBLIC_ENV_MODE=local` → hide; `=cloud` → show | Toggle env, restart, check menu |
| I7 | Subscribe button disabled while pending                                  | Click Subscribe → loading state                         | Button shows "Starting…", disabled | UI |
| I8 | Error toast on Stripe failure                                            | Cancel checkout, return to app                          | Error message shown, no DB changes | UI |

---

## J. Cross-cutting / edge cases

| #  | Scenario                                       | Action                                                                              | Expected                                                                                                  | Verify                                                                                                         |
| -- | ---------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| J1 | Race: simultaneous member adds                  | Two browsers add different members at the same second                               | Both succeed; final `seat_count=N+2`; Stripe converges to correct quantity                                | `SELECT seat_count FROM kortix.credit_accounts; stripe subscriptions retrieve sub_*` (compare quantity)        |
| J2 | Webhook arrives out of order                    | Force two `subscription.updated` events with old before new                         | New seat_count wins; webhook handler is monotonic on quantity                                              | Manual: replay old then new events                                                                              |
| J3 | Stripe API timeout during seat-sync             | Network hiccup mid `syncSeatQuantity`                                               | Local seat_count NOT updated (we removed that); webhook backfills when network recovers                    | Disconnect network during member add; reconnect; verify eventual consistency                                    |
| J4 | API restart mid-compute-session                  | Kill API while sandbox running                                                      | Cron tick re-settles partial cost on next maintenance run                                                  | Restart API, wait 5 min, check `cost_usd` accrues                                                                |
| J5 | Stale plaintext cache after restart              | Restart API, member starts a NEW sandbox                                            | New token minted (old plaintext invalidated); old sandboxes using old plaintext will fail YOLO calls       | Inspect old sandbox env vs new                                                                                  |
| J6 | Deleted account → orphan cleanup                 | DELETE account                                                                      | `credit_accounts`, `sandbox_compute_sessions`, `yolo_member_tokens` all cascade via FK                     | `SELECT COUNT(*) FROM kortix.sandbox_compute_sessions WHERE account_id='<deletedId>';` → 0                      |
| J7 | Float precision                                  | Run a sandbox for exactly 1 second                                                  | `cost_usd` doesn't lose precision (numeric(12,6))                                                          | Verify decimal precision in DB                                                                                  |
| J8 | Negative balance                                  | Force-debit beyond balance via custom script                                        | RPC throws InsufficientCreditsError, balance stays at floor                                                 | Direct SQL test against RPC                                                                                     |

---

## K. Data integrity invariants

Run these as SQL audits — should return 0 rows in all cases:

```sql
-- K1: No orphaned compute sessions (sandbox no longer exists)
SELECT scs.id FROM kortix.sandbox_compute_sessions scs
LEFT JOIN kortix.session_sandboxes ss ON ss.sandbox_id = scs.sandbox_id
WHERE ss.sandbox_id IS NULL AND scs.state = 'active';

-- K2: No YOLO tokens for non-members
SELECT yt.user_id FROM kortix.yolo_member_tokens yt
LEFT JOIN kortix.account_members am ON am.user_id = yt.user_id AND am.account_id = yt.account_id
WHERE am.user_id IS NULL AND yt.revoked_at IS NULL;

-- K3: seat_count diverged from member count
SELECT ca.account_id, ca.seat_count, COUNT(am.*) AS actual_members
FROM kortix.credit_accounts ca
LEFT JOIN kortix.account_members am ON am.account_id = ca.account_id
WHERE ca.billing_model = 'per_seat'
GROUP BY ca.account_id, ca.seat_count
HAVING ca.seat_count <> COUNT(am.*);

-- K4: per_seat accounts without a YOLO token for the owner
SELECT ca.account_id FROM kortix.credit_accounts ca
WHERE ca.billing_model = 'per_seat'
  AND ca.stripe_subscription_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM kortix.yolo_member_tokens yt
    WHERE yt.account_id = ca.account_id AND yt.revoked_at IS NULL
  );

-- K5: Ledger balance reconciliation — sum of ledger should match wallet
SELECT ca.account_id, ca.balance, COALESCE(SUM(cl.amount), 0) AS ledger_sum
FROM kortix.credit_accounts ca
LEFT JOIN kortix.credit_ledger cl ON cl.account_id = ca.account_id
WHERE ca.account_id IN (...)  -- limit to test accounts
GROUP BY ca.account_id, ca.balance
HAVING ABS(ca.balance - COALESCE(SUM(cl.amount), 0)) > 0.01;

-- K6: Duplicate Stripe event processed
SELECT stripe_event_id, COUNT(*) FROM kortix.credit_ledger
WHERE stripe_event_id IS NOT NULL
GROUP BY stripe_event_id HAVING COUNT(*) > 1;
```

---

## L. Performance / load tests

Optional but worth running before prod:

| #  | Scenario                              | How                                                            | Expected                                                                |
| -- | ------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| L1 | 100 simultaneous webhook events       | `stripe events resend` × 100 with `&`                          | Webhook dedup holds, no double-grants                                   |
| L2 | 50 sandboxes started in 1 minute      | Script spinning sessions in parallel                           | All metering rows created; cron tick handles them all                   |
| L3 | Member add storm (10 members in 60s)  | Script invites                                                 | Stripe quantity converges; no orphan rows                                |
| L4 | Daily ledger growth                    | Run a week with 10 active sandboxes                            | Query latency for `getUsageBreakdownThisPeriod` stays sub-100ms          |

---

## M. Automated test suite

Already in place — run before every push:

```bash
cd apps/api
bun test src/__tests__/billing/per-seat-pricing.test.ts \
         src/__tests__/billing/e2e-compute-metering.test.ts \
         src/__tests__/billing/e2e-per-seat-webhooks.test.ts \
         src/__tests__/billing/credits.test.ts \
         src/__tests__/billing/subscriptions.test.ts \
         src/__tests__/billing/webhooks.test.ts
```

**Coverage gap (recommended next):**

- E2E test for `seat-management.ts:onMemberAdded` / `onMemberRemoved` (the file I never wrote)
- E2E test for `usage-breakdown.ts` aggregation correctness
- E2E test for legacy guard (account with `billing_model='legacy'` should no-op everywhere)
- E2E test for the new owner-token mint at subscription start

---

## N. Pre-deploy checklist (cloud / prod)

Before flipping `INTERNAL_KORTIX_ENV=prod`:

- [ ] Create prod `per_seat` Stripe price ($20/mo) under prod product
- [ ] Replace `PER_SEAT_STRIPE_PRICE_ID_PLACEHOLDER` in `STRIPE_PRICES_PROD.subscriptions.per_seat.monthly`
- [ ] Configure prod webhook endpoint in Stripe Dashboard pointing at prod API URL
- [ ] Copy prod webhook signing secret into prod env's `STRIPE_WEBHOOK_SECRET`
- [ ] Verify `INTERNAL_KORTIX_ENV=prod` → `ensureSchema()` is a no-op (managed externally)
- [ ] Apply all migrations (88-92) via your prod migration pipeline (NOT auto-push)
- [ ] Verify no schema collisions with prod's actual migration state
- [ ] Set `NEXT_PUBLIC_ENV_MODE=cloud` on the prod web build
- [ ] Confirm legacy customer cohort sample: their `billing_model='legacy'` is preserved after migration runs
- [ ] Smoke test in staging: full subscribe + member add cycle works end-to-end
- [ ] Document the legacy → per_seat manual migration procedure for support

---

## O. Post-deploy verification (first 24h)

Run hourly:

```sql
-- New per_seat signups in last hour
SELECT COUNT(*) FROM kortix.credit_accounts
WHERE billing_model = 'per_seat' AND created_at > NOW() - INTERVAL '1 hour';

-- Successful subscriptions in last hour
SELECT COUNT(*) FROM kortix.credit_accounts
WHERE billing_model = 'per_seat' AND stripe_subscription_id IS NOT NULL
  AND updated_at > NOW() - INTERVAL '1 hour';

-- Failed Stripe webhook deliveries (check Stripe Dashboard → Developers → Webhooks)

-- Any data integrity violations (run K1-K6 above)

-- Auto-topup failures
SELECT COUNT(*) FROM kortix.credit_accounts
WHERE payment_status = 'failed' AND last_payment_failure > NOW() - INTERVAL '1 hour';
```

---

## P. Manual smoke test — full happy path (15 minutes)

The shortest end-to-end run-through to verify nothing's regressed:

1. ✅ Fresh signup (email A) → see CTA → subscribe → balance $20, seat 1
2. ✅ Invite email B (new user) → email sent → accept → seat 2 → balance $40
3. ✅ As B, open the workspace → see project → start a sandbox → chat for 5 min
4. ✅ Stop the sandbox → `compute_debit` lands → balance < $40
5. ✅ As A, remove B → seat 1 → B's token revoked
6. ✅ As A, cancel subscription → tier reverts → next page load shows CTA again

If all six steps pass, billing-v2 is healthy.

---

## Out of scope (separate work)

- **Mobile/RevenueCat per-seat support** — mobile customers stay on existing per-account tiers; per-seat is web-only at launch
- **Annual / yearly commitments on per-seat** — monthly only for now
- **Admin tools** for legacy→per-seat migration, manual balance adjustments
- **LLM router → `deductForLlmUsage` wiring** — the function exists but isn't called yet; needs router-side integration to land `llm_debit` entries
- **Reporting/analytics dashboards** for finance team — different surface, not user-facing billing

---

## Release-cycle recommendation

- **Pre-commit:** automated test suite (M)
- **Pre-merge:** P (full smoke test)
- **Pre-deploy to staging:** A, B, C, D, E (core flows)
- **Pre-deploy to prod:** N checklist + run K (integrity audits) against staging data
- **Post-deploy:** O monitoring for first 24h, plus G (legacy protection) audit weekly
