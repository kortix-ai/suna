-- Remove the problematic GRANT that bypasses RLS
REVOKE SELECT ON TABLE projects FROM anon;
REVOKE SELECT ON TABLE threads FROM anon;
REVOKE SELECT ON TABLE messages FROM anon;