-- Up Migration

-- When true, the unified auth flow refuses the password/email-code paths for
-- this provider's primary domain: /access/check-email answers mode='sso' and
-- the web auth actions turn the request away, so the IdP is the only door.
-- Off by default — orgs opt in once their SAML connection is proven.
ALTER TABLE kortix.account_sso_providers
  ADD COLUMN IF NOT EXISTS enforce_sso boolean NOT NULL DEFAULT false;

-- Down Migration

ALTER TABLE kortix.account_sso_providers
  DROP COLUMN IF EXISTS enforce_sso;
