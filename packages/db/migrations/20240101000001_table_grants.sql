-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  Table Grants (post drizzle-kit push)                                      ║
-- ║                                                                             ║
-- ║  Grants table-level access to Supabase roles for the kortix schema.        ║
-- ║  No RLS — access control is handled at the API layer.                      ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

-- Future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA kortix GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA kortix GRANT SELECT, INSERT, UPDATE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA kortix GRANT SELECT ON TABLES TO anon;

-- Existing tables
GRANT ALL ON ALL TABLES IN SCHEMA kortix TO service_role;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA kortix TO authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA kortix TO anon;
