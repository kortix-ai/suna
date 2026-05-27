-- Grant access to basejump schema and basejump.billing_customers
-- (created in migration 32). Without these, the API's resolve-account
-- code (which connects as `authenticated`) gets:
--   permission denied for schema basejump
-- and logs "Stripe sync error" on every request.

GRANT USAGE ON SCHEMA basejump TO authenticated, service_role, anon;

ALTER DEFAULT PRIVILEGES IN SCHEMA basejump GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA basejump GRANT SELECT, INSERT, UPDATE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA basejump GRANT SELECT ON TABLES TO anon;

GRANT ALL ON ALL TABLES IN SCHEMA basejump TO service_role;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA basejump TO authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA basejump TO anon;
