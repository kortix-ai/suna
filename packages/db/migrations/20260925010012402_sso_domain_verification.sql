-- Migration: sso_domain_verification
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- SSO domain verification. An email that a SAML IdP asserts is trusted
-- outside the IdP's own account only when the account proved control of the
-- email's domain (DNS TXT record, or a platform operator). `enforce_sso`
-- applies only to a verified domain.
--
-- Providers that exist before this migration were configured by an operator or
-- by an enterprise admin under a sales-assigned entitlement. They keep their
-- current behavior: their domain counts as verified from its creation time.
-- New providers and any later primary_domain change start unverified.

ALTER TABLE "kortix"."account_sso_providers" ADD COLUMN "domain_verification_token" varchar(64);--> statement-breakpoint
ALTER TABLE "kortix"."account_sso_providers" ADD COLUMN "domain_verified_at" timestamp with time zone;--> statement-breakpoint
-- backfill-safe: kortix.account_sso_providers holds at most one row per enterprise account (tens of rows); the UPDATE touches only rows that exist now and finishes in milliseconds
UPDATE "kortix"."account_sso_providers" SET "domain_verified_at" = "created_at" WHERE "domain_verified_at" IS NULL;
