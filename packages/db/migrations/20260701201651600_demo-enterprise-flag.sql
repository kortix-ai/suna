-- Up Migration
--
-- Self-serve "enterprise demo" flag on credit_accounts. When true, the account
-- resolves ALL enterprise entitlements (SSO, SCIM, …) regardless of billing
-- tier — an interactive preview of the enterprise surface, toggled by any
-- account member from settings (PUT /v1/accounts/:id/iam/enterprise-demo).
-- Default false → existing accounts are unaffected and it fails closed. NOT a
-- real Enterprise plan (that stays sales-assigned via credit_accounts.tier).

ALTER TABLE "kortix"."credit_accounts"
  ADD COLUMN "demo_enterprise" boolean NOT NULL DEFAULT false;

-- Down Migration

ALTER TABLE "kortix"."credit_accounts"
  DROP COLUMN "demo_enterprise";
