-- Up Migration
-- Postman collections and Postman-managed repositories are first-class
-- connector sources. Enum additions are forward-only in PostgreSQL.
ALTER TYPE kortix.executor_connector_provider ADD VALUE IF NOT EXISTS 'postman';

-- Down Migration
-- Intentionally empty: removing an enum value would invalidate existing
-- executor connector rows and requires a table rewrite.
