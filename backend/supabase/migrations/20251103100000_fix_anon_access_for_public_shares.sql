-- Fix anonymous access to public shared threads
-- The 20250901030240_security.sql migration revoked SELECT from anon
-- But we need anon to SELECT these tables (RLS policies will protect private data)

GRANT SELECT ON TABLE threads TO anon;
GRANT SELECT ON TABLE messages TO anon;
GRANT SELECT ON TABLE projects TO anon;
GRANT SELECT ON TABLE agent_runs TO anon;
