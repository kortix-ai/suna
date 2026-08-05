-- Up Migration
--
-- Per-account "enterprise entitled" flag for contracted cloud Enterprise
-- customers. When true, the account resolves ALL enterprise entitlements
-- (SAML SSO, SCIM, RBAC, audit access) regardless of its billing tier —
-- decoupling feature entitlements from the commercial billing model.
--
-- WHY. A deal that is BOTH Enterprise (entitlements) AND per-seat (billing) —
-- e.g. $40K/yr Enterprise flat + $40/enabled-seat/mo with pooled per-seat
-- credits — could not previously hold both at once:
--   - Enterprise entitlements require credit_accounts.tier='enterprise' (the
--     only tier whose static TierEntitlements are all-true; see tiers.ts).
--   - Per-seat Stripe webhook reconciliation (webhooks.ts syncSubscriptionState)
--     unconditionally sets tier='per_seat' on every subscription update for a
--     per-seat item — clobbering a sales-assigned tier='enterprise' and
--     stripping SSO/SCIM/RBAC/audit on ordinary subscription updates.
-- `enterprise_entitled` is an independent, operator-set entitlement source
-- (mirrors the shape of the existing `demo_enterprise` self-serve demo flag,
-- but for a real signed contract). tier/billing_model stay free to carry the
-- billing model the deal needs; the entitlement is no longer coupled to them.
--
-- Default false → existing accounts are unaffected and it fails closed. The
-- admin route (POST /v1/admin/api/accounts/:id/enterprise-entitlement) is the
-- documented setter, used when a contract is signed.

ALTER TABLE "kortix"."credit_accounts"
  ADD COLUMN "enterprise_entitled" boolean NOT NULL DEFAULT false;

-- Down Migration

ALTER TABLE "kortix"."credit_accounts"
  DROP COLUMN "enterprise_entitled";
